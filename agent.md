# Arknights TW Gacha Analyzer - Agent Context 指南

這份 `agent.md` 的目的是為了幫助後續接手的 AI Agent 或真人開發者，能夠快速且無縫地載入整個 `Firebase-txwy-arknightsgacha`（明日方舟繁中服）專案的上下文（Context），避免重複踩坑並維持架構一致性。

---

## 📌 1. Project Overview & Context (專案概述與當前上下文)

**核心目標**：
本專案為「明日方舟繁中服 (Arknights TW)」專用的尋訪（抽卡）紀錄分析與視覺化工具。透過與官方服務介接，獲取玩家的尋訪紀錄，並在不持久化保存敏感個人資訊的前提下，提供深度的抽卡統計（各卡池出金率、平均抽數、保底墊抽數等）。

**技術棧 (Tech Stack)**：
*   **後端**：Node.js + Firebase Cloud Functions + Express。
*   **前端**：EJS 樣板引擎 + Vanilla JS/CSS（零前端框架，追求極致輕量化與快速渲染）。
*   **儲存**：Firebase Realtime Database / Firestore（僅用於快取與匿名化統計，**絕對不存**明文 Token 與 Cookie）。
*   **輔助工具**：Chromium 擴充功能，負責從官方網頁中安全提取登入憑證 (Cookie 與 localStorage)。

**當前系統最新狀態**：
*   已完成全面 SEO 優化（於全域注入 Canonical URL 以解決 `web.app` 與 `firebaseapp.com` 重複索引問題、更新 Login 頁面 Meta 內容）。
*   具備全域的 Footer Menu（懸浮選單），統一導覽體驗。

---

## 🏗️ 2. Architecture & Core Concepts (架構與核心概念)

### 核心目錄與職責
*   `functions/index.js`：應用的進入點。負責初始化 Express、定義所有 API 路由 (`/login`, `/privacy`, `/api/log` 等)、處理跨域 (CORS) 以及中介軟體 (Middleware，如 SEO Canonical URL)。
*   `functions/utils.js`：核心業務邏輯的重鎮。包含向官方 API 發送請求的抓取邏輯，以及最關鍵的 `analyzeLogs`（負責將原始資料進行清洗、計算保底、分類卡池）。
*   `functions/views/`：
    *   `login.ejs`：Landing Page，負責引導使用者安裝擴充功能或進行登入，包含完整的工具介紹與 SEO 內容。
    *   `index.ejs`：資料展示的儀表板 (Dashboard)。負責渲染總覽數據與近期出金。
    *   `privacy.ejs`：隱私權政策聲明頁面。

### 核心架構決策 (Architecture Decisions)
1.  **無狀態架構與隱私優先**：使用者的憑證（Tokens、Cookies）僅在記憶體中短暫停留，用於向官方發起代理請求後即銷毀，實作「用完即棄」。
2.  **UID 識別 (UID-based Indexing)**：明日方舟的資料庫索引與快取機制使用玩家的遊戲內 `uid` 作為唯一識別碼（與終末地的 `roleId` 不同）。

---

## 🚦 3. Development Guidelines (開發與上手指南)

**本地啟動與測試**：
1.  **安裝依賴**：切換至 `functions/` 目錄並執行 `npm install`。
2.  **啟動 Firebase 模擬器**：執行 `firebase emulators:start` 啟動本地測試伺服器（通常運行於 `localhost:5000`）。
3.  **部署上線**：確認無誤後，使用 `firebase deploy --only functions,hosting` 進行部署。

**代碼風格**：
*   **前端**：盡量維持 Vanilla JS，避免過早引入大型建置工具（如 Webpack/Vite）。
*   **後端**：維持無狀態 (Stateless)，確保所有的暫存與運算都不依賴特定的 Function 實例。

---

## ⚠️ 4. Trade-offs & Pitfalls (權衡取捨與已知陷阱)

在接手本專案時，請務必注意以下「雷區」與設計限制：

1.  **星級映射邏輯陷阱 (Critical Pitfall - Rarity Mapping)**：
    *   明日方舟官方 API 回傳的星級格式為文字（例如 `"6星"`, `"5星"`）。
    *   在 `utils.js` 的 `analyzeLogs` 中，我們使用了一個轉換映射表：`let rarityMap = { '3星': '2', '4星': '3', '5星': '4', '6星': '5' };`
    *   **警告**：因此，在統計資料（如 `allCounts`, `lastCounts`）中，**`['5']` 代表的是 6 星幹員**！在維護或修改前端數據渲染時，絕對不要把 `['6']` 當作 6 星，否則會報錯或顯示空白。
2.  **僅有幹員，沒有武器**：
    *   明日方舟的尋訪**只有幹員**。請勿將終末地的「武庫申領」或「武器/角色分離」邏輯直接套用過來。
3.  **防爬蟲與併發限制**：
    *   向官方獲取資料的 `fetchAllLogsSlowly` 等函數中，刻意保留了 `sleep(200)` 等延遲機制，這是為了避免觸發官方 API 的 Rate Limit 或 WAF 阻擋。**請勿**為了追求速度而移除這些延遲。
4.  **跨專案注意事項 (Cross-Project Awareness)**：
    *   如果您同時維護 `Firebase-endfieldgacha` (終末地)，請隨時意識到兩者的星級判定邏輯（0-indexed 映射 vs 數字原生星級）與卡池結構完全不同，切勿盲目複製貼上核心運算邏輯。
