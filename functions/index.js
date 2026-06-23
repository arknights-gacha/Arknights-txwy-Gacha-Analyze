const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require('express');
const multer = require('multer');
const path = require('path');
const { 
    getUid, 
    fetchAllLogsSlowly, 
    mergeLogs, 
    analyzeLogs 
} = require('./utils');

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Trust proxy for Firebase Hosting
app.set('trust proxy', 1);

const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: '存取過於頻繁，請稍後再試。',
  skip: (req, res) => process.env.FUNCTIONS_EMULATOR === 'true'
});
app.use(limiter);

app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public'))); // Serving CSS logic

// Set canonical URL for SEO indexing
app.use((req, res, next) => {
    let path = req.originalUrl.split('?')[0]; // Ignore query strings for canonical purposes
    res.locals.canonicalUrl = `https://arknights-txwy-gacha.web.app${path}`;
    next();
});

// Basic session using a cookie (cookie-parser and basic token can be better, but we will use a simple UID cookie for this example app to replace Flask Session)
const cookieParser = require('cookie-parser');
app.use(cookieParser('firebase-arknights-secret'));

app.get('/', async (req, res) => {
    let sessionData = req.signedCookies.__session;
    
    // Backward compatibility for old string cookies
    if (typeof sessionData === 'string') {
        sessionData = { uid: sessionData, authUid: null };
        res.cookie('__session', sessionData, { signed: true, httpOnly: true });
    }

    if (!sessionData || !sessionData.uid) {
        return res.redirect('/login');
    }
    
    const uid = sessionData.uid;
    const authUid = sessionData.authUid || null;
    
    try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.redirect('/login');
        }
        
        let info = userDoc.data().info || {};
        
        // Authorization check for locked data
        if (info.Lock && info.Lock !== authUid) {
            return res.render('auth_prompt', { method: 'reauth', uid: uid, logs: null, flash: '您的授權已過期或資料已上鎖，請重新驗證' });
        }
        
        let nickname = info.nickName || uid;
        
        const logsDoc = await db.collection('users').doc(uid).collection('data').doc('logs').get();
        let logs = [];
        if (logsDoc.exists) {
            const data = logsDoc.data();
            logs = data.jsonString ? JSON.parse(data.jsonString) : (data.records || []);
        }
        
        // Analyze logs to plot and interval markup
        const analyzed = analyzeLogs(logs);
        
        res.render('index', {
            logs: analyzed.logs,
            stats: analyzed,
            nickname: nickname,
            uid: uid,
            isLocked: !!info.Lock
        });
    } catch (e) {
        console.error(e);
        res.render('login', { flash: '加載錯誤，請重新登入' });
    }
});

app.get('/login', (req, res) => {
    res.render('login', { flash: null });
});

app.get('/privacy', (req, res) => {
    res.render('privacy');
});

app.post('/login', async (req, res) => {
    const method = req.body.method;
    
    try {
        if (method === 'cookie') {
            const userCookie = req.body.cookie.trim().replace(/[\r\n]+/g, '');
            const roleToken = req.body.token.trim().replace(/[\r\n]+/g, '');
            
            const [uid, infoData] = await getUid(roleToken, userCookie);
            console.log(`UID: ${uid}`);
            
            let logs = await fetchAllLogsSlowly(uid, roleToken, userCookie);
            console.log(`Fetched ${logs.length} logs`);
            
            const userDocRef = db.collection('users').doc(uid);
            const userDoc = await userDocRef.get();
            let authUid = null;
            
            if (userDoc.exists) {
                const existingInfo = userDoc.data().info || {};
                authUid = existingInfo.Lock || null;
                infoData.ts = existingInfo.ts || Math.floor(Date.now() / 1000);
                if (existingInfo.Lock) infoData.Lock = existingInfo.Lock;
            } else {
                infoData.ts = Math.floor(Date.now() / 1000);
            }
            
            const logsDocRef = userDocRef.collection('data').doc('logs');
            const logsDoc = await logsDocRef.get();
            if (logsDoc.exists) {
                const data = logsDoc.data();
                let existing = data.jsonString ? JSON.parse(data.jsonString) : (data.records || []);
                logs = mergeLogs(logs, existing);
            }
            
            // Save to Firestore
            await userDocRef.set({ info: infoData }, { merge: true });
            
            // For large logs, they shouldn't exceed 1MB in a single document representing roughly 10k pulls.
            // Using JSON.stringify bypasses Firestore's massive per-object array overhead.
            await logsDocRef.set({ jsonString: JSON.stringify(logs) });
            
            res.cookie('__session', { uid: uid, authUid: authUid }, { signed: true, httpOnly: true });
            return res.redirect('/');
        } else if (method === 'existing') {
            const uid = req.body.uid;
            const userDoc = await db.collection('users').doc(uid).get();
            if (userDoc.exists) {
                const info = userDoc.data().info || {};
                if (info.Lock) {
                    return res.render('auth_prompt', { method: 'existing', uid: uid, logs: null, flash: null });
                }
                res.cookie('__session', { uid: uid, authUid: null }, { signed: true, httpOnly: true });
                return res.redirect('/');
            } else {
                return res.render('login', { flash: '找不到該 ID 的紀錄' });
            }
        } else if (method === 'upload') {
            const uid = req.body.uid;
            const logs = req.body.logs;
            if (!uid || uid.length < 5 || isNaN(uid)) {
                return res.status(400).send('請提供有效的 ID');
            }
            if (logs && Array.isArray(logs)) {
                const userDocRef = db.collection('users').doc(uid);
                const userDoc = await userDocRef.get();
                
                if (userDoc.exists) {
                    const info = userDoc.data().info || {};
                    if (info.Lock) {
                        return res.render('auth_prompt', { method: 'upload', uid: uid, logs: logs, flash: null });
                    }
                } else {
                    await userDocRef.set({ info: { uid: uid, nickName: uid, ts: Math.floor(Date.now() / 1000) } }, { merge: true });
                }
                
                const logsDocRef = userDocRef.collection('data').doc('logs');
                await logsDocRef.set({ jsonString: JSON.stringify(logs) });
                
                res.cookie('__session', { uid: uid, authUid: null }, { signed: true, httpOnly: true });
                return res.redirect('/');
            } else {
                return res.status(400).send('請提供 ID 與檔案格式錯誤');
            }
        }
    } catch (e) {
        console.error(e);
        return res.render('login', { flash: e.toString() });
    }
});

app.get('/export', async (req, res) => {
    let sessionData = req.signedCookies.__session;
    if (typeof sessionData === 'string') {
        sessionData = { uid: sessionData, authUid: null };
        res.cookie('__session', sessionData, { signed: true, httpOnly: true });
    }
    if (!sessionData || !sessionData.uid) {
        return res.redirect('/login');
    }
    const uid = sessionData.uid;
    const authUid = sessionData.authUid || null;
    
    try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(404).send('No logs found.');
        }
        
        const info = userDoc.data().info || {};
        if (info.Lock && info.Lock !== authUid) {
            return res.status(401).send('Unauthorized. Data is locked.');
        }

        const logsDoc = await db.collection('users').doc(uid).collection('data').doc('logs').get();
        if (!logsDoc.exists) {
            return res.status(404).send('No logs found.');
        }
        const data = logsDoc.data();
        const logs = data.jsonString ? JSON.parse(data.jsonString) : (data.records || []);
        res.setHeader('Content-disposition', `attachment; filename=visit_logs_${uid}.json`);
        res.setHeader('Content-type', 'application/json');
        res.send(JSON.stringify(logs, null, 2));
    } catch (e) {
        console.error(e);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('__session');
    res.redirect('/login');
});

// Post handler for Firebase Auth token verification
app.post('/login_locked', async (req, res) => {
    const { idToken, uid, method, logs } = req.body;
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const authUid = decodedToken.uid;
        
        const userDocRef = db.collection('users').doc(uid);
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User not found' });
        
        const info = userDoc.data().info || {};
        if (info.Lock !== authUid) {
            return res.status(403).json({ success: false, error: '帳號授權不符，無法解鎖資料' });
        }
        
        if (method === 'upload' && logs) {
            const logsDocRef = userDocRef.collection('data').doc('logs');
            await logsDocRef.set({ jsonString: JSON.stringify(logs) });
        }
        
        res.cookie('__session', { uid: uid, authUid: authUid }, { signed: true, httpOnly: true });
        return res.json({ success: true, redirect: '/' });
    } catch (e) {
        console.error(e);
        return res.status(401).json({ success: false, error: '驗證失敗' });
    }
});

// API endpoint for toggling the lock
app.post('/api/toggleLock', async (req, res) => {
    let sessionData = req.signedCookies.__session;
    if (typeof sessionData === 'string') {
        sessionData = { uid: sessionData, authUid: null };
        res.cookie('__session', sessionData, { signed: true, httpOnly: true });
    }
    if (!sessionData || !sessionData.uid) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const uid = sessionData.uid;
    
    const { idToken, action } = req.body;
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const tokenUid = decodedToken.uid;
        
        const userDocRef = db.collection('users').doc(uid);
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User not found' });
        
        const info = userDoc.data().info || {};
        
        if (action === 'lock') {
            if (info.Lock) {
                return res.status(400).json({ success: false, error: 'Already locked' });
            }
            await userDocRef.set({ info: { Lock: tokenUid } }, { merge: true });
            res.cookie('__session', { uid: uid, authUid: tokenUid }, { signed: true, httpOnly: true });
            return res.json({ success: true });
        } else if (action === 'unlock') {
            if (info.Lock !== tokenUid) {
                return res.status(403).json({ success: false, error: 'Token UID does not match Lock UID' });
            }
            const { FieldValue } = require('firebase-admin/firestore');
            await userDocRef.update({ 'info.Lock': FieldValue.delete() });
            res.cookie('__session', { uid: uid, authUid: null }, { signed: true, httpOnly: true });
            return res.json({ success: true });
        }
    } catch (e) {
        console.error(e);
        return res.status(500).json({ success: false, error: 'Internal error: ' + (e.message || e.toString()) });
    }
});

// Export the Express app as a Firebase Function (HTTP), set region to Taiwan and restrict maxInstances for cost control
exports.app = onRequest({ region: "asia-east1", invoker: "public", maxInstances: 20, concurrency: 40, memory: "512MiB" }, app);
