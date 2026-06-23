const axios = require('axios');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatDateTime(timestamp) {
    const date = new Date(timestamp * 1000);
    const yr = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const da = String(date.getDate()).padStart(2, '0');
    const hr = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const se = String(date.getSeconds()).padStart(2, '0');
    return `${yr}/${mo}/${da} ${hr}:${mi}:${se}`;
}

async function getUid(roleToken = '', userCookie = '') {
    const url = 'https://ak.gryphline.com/user/api/redeem/info';
    const CookieStr = `cookiePref=all; ak-user-tw=${userCookie}`;
    
    const response = await axios.get(url, {
        headers: {
            'X-Role-Token': roleToken,
            'Cookie': CookieStr
        }
    });
    
    const js = response.data;
    
    // add a timestamp
    js.data.lastFetched = Math.floor(Date.now() / 1000);
    
    if (js.code !== 0) {
        throw new Error(`API code=${js.code}`);
    }
    
    return [js.data.uid, js.data];
}

async function fetchVisitLogPage(uid, page, roleToken, userCookie) {
    const url = 'https://ak.gryphline.com/user/api/redeem/visitLog';
    const payload = { uid: Number(uid), page: page };
    const CookieStr = `cookiePref=all; ak-user-tw=${userCookie}`;
    
    const response = await axios.post(url, payload, {
        headers: {
            'Content-Type': 'application/json',
            'X-Role-Token': roleToken,
            'Cookie': CookieStr
        }
    });
    
    const js = response.data;
    if (js.code !== 0) {
        throw new Error(`API code=${js.code}`);
    }
    
    return js.data.list;
}

async function fetchAllLogsSlowly(uid, roleToken = '', userCookie = '') {
    let allLogs = [];
    let page = 1;
    while (true) {
        const lst = await fetchVisitLogPage(uid, page, roleToken, userCookie);
        if (!lst || lst.length === 0) {
            break;
        }
        allLogs = allLogs.concat(lst);
        page += 1;
        await sleep(200);
    }
    
    for (let item of allLogs) {
        item.time = formatDateTime(item.ts);
    }
    return allLogs;
}

function mergeLogs(records, previousRecords) {
    let cursorNow = 0;
    let cursorPrev = 0;
    
    while (cursorNow < records.length && cursorPrev < previousRecords.length) {
        let cursorNowBak = cursorNow;
        let cursorPrevBak = cursorPrev;
        
        let clusterNow = [records[cursorNow]];
        let clusterPrev = [previousRecords[cursorPrev]];
        
        cursorNow += 1;
        cursorPrev += 1;
        
        while (cursorNow < records.length && records[cursorNow].ts === clusterNow[0].ts) {
            clusterNow.push(records[cursorNow]);
            cursorNow += 1;
        }
        
        while (cursorPrev < previousRecords.length && previousRecords[cursorPrev].ts === clusterPrev[0].ts) {
            clusterPrev.push(previousRecords[cursorPrev]);
            cursorPrev += 1;
        }
        
        if (clusterNow.length === 0 || clusterPrev.length === 0) {
            break;
        } else if (clusterNow[0].ts === clusterPrev[0].ts) {
            if (clusterNow.length > 10 || clusterPrev.length > 10) {
                console.warn(`Warning: too many records in the same time cluster, ${clusterNow.length} vs ${clusterPrev.length}, please check manually.`);
            }
            if (clusterNow.length === clusterPrev.length) {
                for (let i = 0; i < clusterPrev.length; i++) {
                    if (previousRecords[cursorPrevBak].charName === clusterNow[i].charName) {
                        previousRecords.splice(cursorPrevBak, 1);
                    } else {
                        console.warn(`Warning: oprator name not matching, ${previousRecords[cursorPrevBak].charName} vs ${clusterNow[i].charName}`);
                        previousRecords.splice(cursorPrevBak, 1);
                    }
                }
                cursorPrev = cursorPrevBak;
            } else {
                console.warn(`Warning: records length not matching, ${clusterNow.length} vs ${clusterPrev.length}, keep the longer one`);
                if (clusterNow.length > clusterPrev.length) {
                    for (let i = 0; i < clusterPrev.length; i++) {
                        previousRecords.splice(cursorPrevBak, 1);
                        cursorPrev = cursorPrevBak;
                    }
                } else {
                    for (let i = 0; i < clusterNow.length; i++) {
                        records.splice(cursorNowBak, 1);
                        cursorNow = cursorNowBak;
                    }
                }
                break;
            }
        } else {
            cursorPrev = cursorPrevBak;
        }
    }
    return records.concat(previousRecords);
}

function classifyPool(poolId) {
    if (!poolId) return '其他尋訪';
    
    const categories = {
        '所有卡池': [],
        '限定尋訪': ['LIMITED', 'LINKAGE'],
        '標準尋訪': ['NORM', 'SINGLE', 'DOUBLE', 'SPECIAL'],
        '中堅尋訪': ['CLASSIC', 'FESCLASSIC', 'CLASSIC_DOUBLE'],
        '其他尋訪': ['ATTAIN_CLASSIC', 'CLASSIC_ATTAIN', 'ATTAIN', 'BOOT'],
    };
    
    for (let cat of ['其他尋訪', '中堅尋訪', '標準尋訪', '限定尋訪']) {
        for (let pre of categories[cat]) {
            if (poolId.toUpperCase().startsWith(pre)) {
                return cat;
            }
        }
    }
    return '其他尋訪';
}

function analyzeLogs(logs) {
    let logsCopy = logs;
    logsCopy.reverse();
    
    let n = logsCopy.length;
    let starcounts = {
        '所有卡池': { '5': 0, '4': 0, '3': 0, '2': 0 },
        '限定尋訪': { '5': 0, '4': 0, '3': 0, '2': 0 },
        '標準尋訪': { '5': 0, '4': 0, '3': 0, '2': 0 },
        '中堅尋訪': { '5': 0, '4': 0, '3': 0, '2': 0 },
        '其他尋訪': { '5': 0, '4': 0, '3': 0, '2': 0 }
    };
    let starcountsPool = {};
    let countAcc = { '標準尋訪': 0, '中堅尋訪': 0 };
    
    for (let i = 0; i < n; i++) {
        let item = logsCopy[i];
        let rarity = String(item.rarity);
        
        starcounts['所有卡池'][rarity]++;
        let pool = (item.poolId || '').toUpperCase();
        let category = classifyPool(pool);
        starcounts[category][rarity]++;
        
        if (!starcountsPool[pool]) {
            starcountsPool[pool] = { '5': 0, '4': 0, '3': 0, '2': 0 };
        }
        starcountsPool[pool][rarity]++;
        
        if (category === "標準尋訪") {
            countAcc['標準尋訪']++;
            if (rarity === "5") {
                logsCopy[i].interval = countAcc['標準尋訪'];
                countAcc['標準尋訪'] = 0;
            }
        } else if (category === "中堅尋訪") {
            countAcc['中堅尋訪']++;
            if (rarity === "5") {
                logsCopy[i].interval = countAcc['中堅尋訪'];
                countAcc['中堅尋訪'] = 0;
            }
        } else {
            if (countAcc[pool] === undefined) {
                countAcc[pool] = 0;
            }
            countAcc[pool]++;
            if (rarity === "5") {
                logsCopy[i].interval = countAcc[pool];
                countAcc[pool] = 0;
            }
        }
    }
    
    logsCopy.reverse();
    let lastPullItem = logsCopy[0] || {};
    let lastPullName = lastPullItem.poolName ? lastPullItem.poolName : lastPullItem.poolId;
    let lastPullId = lastPullItem.poolId || '';
    let category = classifyPool(lastPullId);
    let accumulation = countAcc[category] !== undefined ? countAcc[category] : (countAcc[lastPullId] !== undefined ? countAcc[lastPullId] : 0);
    
    return {
        logs: logsCopy,
        starcounts,
        starcountsPool,
        lastPullName,
        lastPullId,
        accumulation,
        countAcc: countAcc,
        totalPulls: logsCopy.length
    };
}

module.exports = {
    getUid,
    fetchVisitLogPage,
    fetchAllLogsSlowly,
    mergeLogs,
    analyzeLogs
};
