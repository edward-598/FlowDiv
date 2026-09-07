# FlowDiv Auto V1

手機優先的台股追蹤 Dashboard，固定追蹤 13 檔：
2885、2887、2891、4915、8422、0050、00830、009805、1301、1717、2303、2882、2883。

## 自動更新
GitHub Actions 在台灣時間週一至週五 14:30、15:30、16:30、18:30 嘗試更新。
原因：收盤價先公布，三大法人資料通常較晚完整，因此分段更新。

## 資料
- TWSE OpenAPI：上市個股日成交資訊
- TWSE T86：三大法人個股買賣超
- TWSE 上市公司股利分派 OpenAPI
- TWSE ETF e添富：ETF 配息頁（fallback parser）

## 部署到 GitHub Pages
1. 建立 GitHub repository。
2. 把這個資料夾內所有檔案上傳到 repo 根目錄。
3. Settings → Pages → Build and deployment → Deploy from a branch。
4. Branch 選 `main`、資料夾選 `/ (root)`。
5. 到 Actions 頁籤執行一次 `Update FlowDiv data`。
6. 之後會在交易日自動更新。

## 風險分數
0–30 穩定、31–50 留意、51–70 偏高、71–100 高。
分數使用單日漲跌、日內振幅、成交量相對近期均量、法人買賣超占成交量等交易結構指標。
這是風險提示，不是價格預測。

## 重要
「法人估算淨流入」= 三大法人淨買賣超股數 × 收盤價，為比較用估算值，不是交易所公布的精確資金金額。
