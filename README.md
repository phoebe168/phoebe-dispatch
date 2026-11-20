# phoebe 派案進度追蹤

老師回覆第一次服務日，管理者追蹤進度、審核異動、整理超過 7 天的異動通報資料。

- 前端：`docs/`（GitHub Pages）
- 後端：`gas/Code.gs`（Google Apps Script，資料存在 phoebe 帳號的 Google 試算表）
- 測試：`test/`（本機模擬，不影響正式資料）

## 規則

- 派案當天算第 0 天，假日照算。
- 老師可選派案日起 15 天內、今天以後的日期。第 0～7 天正常，第 8～15 天必須填原因。
- 已回覆的日期要改，老師提出申請，管理者核准才生效。
- 15 天內排不出來，老師按「無法服務」，管理者改派。改派後天數仍照原派案日計算。
- 首次服務落在第 8～15 天的案子，列入「異動通報」清單，管理者通報完打勾。

## 部署步驟

### 一、後端（用 phoebe 的 Google 帳號）

1. 新增一份 Google 試算表，命名「phoebe 派案追蹤」。
2. 擴充功能 > Apps Script，刪掉預設內容，貼上 `gas/Code.gs` 全部內容，存檔。
3. 修改檔案上方 `SETUP_ADMIN` 的姓名與手機（美英的）。
4. 上方函式選單選 `setup`，按「執行」，第一次會要求授權，照畫面同意。
5. 下方「執行記錄」會顯示管理者 PIN，記下來。
6. 測試期間可執行 `createTestData`，會建立 3 位測試老師與 6 筆派案，老師 PIN 也在執行記錄裡。
7. 右上「部署」>「新增部署作業」> 類型選「網頁應用程式」
   - 執行身分：我
   - 存取權：所有人
8. 複製「網頁應用程式網址」（結尾是 `/exec`）。

> 之後改了 Code.gs，要用「部署 > 管理部署作業 > 編輯 > 版本：新版本」更新，網址不變。

### 二、前端（用 Jarvis 的 GitHub 帳號）

1. 把 `docs/config.js` 的 `API_URL` 換成上一步的網址。
2. 在 GitHub 建立 repo `phoebe-dispatch`，把整個資料夾推上去。
3. repo 的 Settings > Pages > Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾選 `/docs`，存檔。
4. 一兩分鐘後網址會是 `https://<你的帳號>.github.io/phoebe-dispatch/`。

### 三、正式上線前

1. 請美英提供服務項目、區域、老師名單。
2. 在 Apps Script 執行 `clearTestData`，會刪除所有派案、異動、紀錄與老師帳號，管理者保留。
3. 用管理者登入，到「選項」填服務項目與區域，到「帳號」逐一建立老師並把 PIN 私下告知。

## 忘記 PIN

- 老師：管理者到「帳號」按「重設 PIN」。
- 管理者：另一位管理者幫忙重設；只有一位管理者時，在 Apps Script 執行 `resetAdminPin`，新 PIN 在執行記錄。

## 本機測試

```
node test/api.test.js        # 後端邏輯測試
node test/server.js          # 開 http://localhost:8080 實際操作，PIN 在 test/pins.txt
python3 test/ui_test.py      # 畫面自動測試（需先開 server，需安裝 playwright）
```

## 試算表各工作表

帳號、登入、派案、異動申請、選項、紀錄。每次操作都會寫一筆到「紀錄」，可追查誰在什麼時間做了什麼。
請不要手動改「帳號」的 PIN 雜湊、鹽、登入版本欄位。
