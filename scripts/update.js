const fs = require("fs");
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

const TZ = "Asia/Taipei";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = (d = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
}).format(d);
const ymdCompact = d => ymd(d).replaceAll("-", "");
const monthCompact = d => {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone: TZ, year: "numeric", month: "2-digit"}).format(d);
  return parts.replace("-", "") + "01";
};
const previousMonth = (d, n = 1) => {
  const f = new Intl.DateTimeFormat("en-CA", {timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"}).format(d);
  const [y,m] = f.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - n, 15, 12));
};
const num = x => {
  if (x === null || x === undefined || x === "" || x === "--" || x === "---") return null;
  const n = Number(String(x).replaceAll(",", "").replace(/[+X]/g, "").trim());
  return Number.isFinite(n) ? n : null;
};
const avg = xs => xs.length ? xs.reduce((a,b) => a+b, 0) / xs.length : null;
const round = (n, digits=2) => n == null ? null : Number(n.toFixed(digits));

async function getJSON(url) {
  const r = await fetch(url, {headers: {"User-Agent": "FlowDiv/1.1 personal dashboard"}});
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function rocDateToISO(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{2,3})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
  if (!m) return s;
  return `${Number(m[1]) + 1911}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`;
}

async function historyMonth(code, date) {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ymdCompact(date)}&stockNo=${encodeURIComponent(code)}&response=json`;
  const j = await getJSON(url);
  if (!j.data || !j.fields) return [];
  const ix = Object.fromEntries(j.fields.map((x,i) => [x,i]));
  const pick = (r, names) => { for (const k of names) if (ix[k] !== undefined) return r[ix[k]]; return null; };
  return j.data.map(r => ({
    date: rocDateToISO(pick(r,["日期"])),
    volume: num(pick(r,["成交股數"])),
    turnover: num(pick(r,["成交金額"])),
    open: num(pick(r,["開盤價"])),
    high: num(pick(r,["最高價"])),
    low: num(pick(r,["最低價"])),
    close: num(pick(r,["收盤價"])),
    change: num(pick(r,["漲跌價差"]))
  })).filter(x => x.close != null && x.date);
}

async function history30(code, now) {
  let rows = [];
  // 當月一定先抓；若不足 30 個交易日，再往前補前月資料。
  for (let i=0; i<3 && rows.length<30; i++) {
    const d = i === 0 ? now : previousMonth(now, i);
    const monthRows = await historyMonth(code, d).catch(() => []);
    rows = rows.concat(monthRows);
    if (i < 2) await sleep(70);
  }
  const uniq = new Map(rows.map(x => [x.date, x]));
  return [...uniq.values()].sort((a,b) => a.date.localeCompare(b.date)).slice(-30);
}

async function t86(dateCompact) {
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${dateCompact}&selectType=ALLBUT0999&response=json`;
  const j = await getJSON(url);
  return {fields:j.fields || [], data:j.data || []};
}

function t86Map(payload) {
  const fields = payload.fields || [];
  const ix = Object.fromEntries(fields.map((x,i) => [x,i]));
  const get = (r, names, fallbackIndex) => {
    for (const n of names) if (ix[n] !== undefined) return r[ix[n]];
    return fallbackIndex == null ? null : r[fallbackIndex];
  };
  const map = new Map();
  for (const r of payload.data || []) {
    const code = String(get(r,["證券代號"],0) || "").trim();
    if (!code) continue;
    const foreign = num(get(r,["外陸資買賣超股數(不含外資自營商)","外資及陸資買賣超股數(不含外資自營商)"],4));
    const trust = num(get(r,["投信買賣超股數"],10));
    const dealer = num(get(r,["自營商買賣超股數"],11));
    const total = num(get(r,["三大法人買賣超股數"],18));
    map.set(code,{foreign,trust,dealer,total});
  }
  return map;
}

function trendCalc(hist) {
  if (!hist.length) return null;
  const h30 = hist.slice(-30);
  const last = h30.at(-1);
  const closes = h30.map(x => x.close).filter(Number.isFinite);
  const h20 = h30.slice(-20);
  const ma20 = avg(h20.map(x => x.close).filter(Number.isFinite)); // 台股慣用「月線」≈20交易日
  const avg30 = avg(closes);
  const high30 = Math.max(...h30.map(x => x.high ?? x.close).filter(Number.isFinite));
  const low30 = Math.min(...h30.map(x => x.low ?? x.close).filter(Number.isFinite));
  const price = last.close;
  const vsMa20Pct = ma20 ? (price / ma20 - 1) * 100 : null;
  const vsAvg30Pct = avg30 ? (price / avg30 - 1) * 100 : null;
  const fromHighPct = high30 ? (price / high30 - 1) * 100 : null;
  const fromLowPct = low30 ? (price / low30 - 1) * 100 : null;
  const nearHigh = Number.isFinite(fromHighPct) && fromHighPct >= -3;
  const belowMonthLine = Number.isFinite(vsMa20Pct) && vsMa20Pct < 0;

  let signal = {key:"watch", label:"停看聽", color:"yellow", reason:"價格位於短期中間區，先觀察量價與法人方向"};
  // 規則式參考，不做報酬保證：綠=相對不追高、粉紅=偏熱/風險、黃=中性。
  if (nearHigh && Number.isFinite(vsMa20Pct) && vsMa20Pct >= 5) {
    signal = {key:"caution", label:"不追價", color:"pink", reason:"接近30日高點且明顯高於月線，短線追價風險偏高"};
  } else if (belowMonthLine && Number.isFinite(fromHighPct) && fromHighPct <= -5 && Number.isFinite(fromLowPct) && fromLowPct >= 2) {
    signal = {key:"opportunity", label:"可分批留意", color:"green", reason:"跌破月線且已離30日高點一段距離，可觀察止跌與法人回流"};
  } else if (Number.isFinite(vsAvg30Pct) && vsAvg30Pct <= -3 && !nearHigh) {
    signal = {key:"opportunity", label:"可分批留意", color:"green", reason:"價格低於30日均價，估值位置相對不追高，仍需確認趨勢"};
  }

  const tags = [];
  if (belowMonthLine) tags.push("跌破月線");
  else if (Number.isFinite(vsMa20Pct)) tags.push("站上月線");
  if (nearHigh) tags.push("接近30日高點");
  if (Number.isFinite(vsAvg30Pct)) tags.push(`${vsAvg30Pct>=0?"高於":"低於"}30日均價 ${Math.abs(vsAvg30Pct).toFixed(1)}%`);

  return {
    days:h30.length,
    priceDate:last.date,
    ma20:round(ma20),
    avg30:round(avg30),
    high30:round(high30),
    low30:round(low30),
    vsMa20Pct:round(vsMa20Pct),
    vsAvg30Pct:round(vsAvg30Pct),
    fromHighPct:round(fromHighPct),
    fromLowPct:round(fromLowPct),
    belowMonthLine,
    nearHigh,
    tags,
    signal
  };
}

function riskCalc(s, hist) {
  if (s.price == null) return {score:null, level:"等待資料", reasons:[]};
  let score=10, reasons=[];
  const pct=Math.abs(s.changePct || 0);
  if (pct>=7) {score+=22; reasons.push("單日漲跌幅很大");}
  else if (pct>=4) {score+=15; reasons.push("單日波動偏大");}
  else if (pct>=2) score+=7;
  if (s.high!=null && s.low!=null && s.price) {
    const prev=s.price-(s.change||0);
    const amp=prev ? ((s.high-s.low)/prev*100) : 0;
    if (amp>=7) {score+=18; reasons.push("日內振幅偏高");}
    else if (amp>=4) {score+=10; reasons.push("日內振幅擴大");}
    if ((s.changePct||0)<0 && s.high>s.low) {
      const pos=(s.price-s.low)/(s.high-s.low);
      if (pos<0.2) {score+=10; reasons.push("下跌且收盤接近日低");}
    }
  }
  const vols=hist.slice(-20,-1).map(x=>x.volume).filter(Number.isFinite);
  if (vols.length>=5 && s.volume) {
    const vr=s.volume/avg(vols);
    if (vr>=2) {score+=15; reasons.push(`成交量約 ${vr.toFixed(1)} 倍近期均量`);}
    else if (vr>=1.4) {score+=8; reasons.push("成交量明顯放大");}
  }
  const total=s.institutional?.total;
  if (Number.isFinite(total) && s.volume) {
    const r=total/s.volume;
    if (r<=-0.15) {score+=18; reasons.push("法人賣超占成交量比重高");}
    else if (r<=-0.07) {score+=10; reasons.push("法人籌碼偏流出");}
    if (r>=0.15 && score>10) score-=5;
  }
  score=Math.max(0,Math.min(100,Math.round(score)));
  const level=score>=71?"高":score>=51?"偏高":score>=31?"留意":"穩定";
  if (!reasons.length) reasons.push("今日未見明顯異常交易訊號");
  return {score,level,reasons};
}

function field(row, names) {
  for (const n of names) if (Object.prototype.hasOwnProperty.call(row,n)) return row[n];
  return null;
}

async function stockDividends() {
  try { return await getJSON("https://openapi.twse.com.tw/v1/opendata/t187ap45_L"); }
  catch { return []; }
}

async function etfDividend(code) {
  try {
    const r=await fetch(`https://www.twse.com.tw/zh/ETFortune-institute/dividendList?stkNo=${encodeURIComponent(code)}`,{headers:{"User-Agent":"FlowDiv/1.1 personal dashboard"}});
    const txt=await r.text();
    const plain=txt.replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ");
    const i=plain.indexOf(code);
    if(i<0) return null;
    const chunk=plain.slice(i,i+700);
    const dates=[...chunk.matchAll(/(20\d{2})[\/-](\d{2})[\/-](\d{2})/g)].map(m=>`${m[1]}-${m[2]}-${m[3]}`);
    const nums=[...chunk.matchAll(/\s(\d+(?:\.\d+)?)\s/g)].map(m=>Number(m[1])).filter(n=>n>0&&n<50);
    return {exDate:dates[0]||null,payDate:dates[2]||dates[1]||null,cash:nums[0]||null};
  } catch { return null; }
}

(async()=>{
  const now = new Date();
  const divRows = await stockDividends();
  const out = [];

  // 1) 每檔股票直接用 STOCK_DAY 當月資料最後一筆作為「最新價格」。
  // 2) 為了近30交易日分析，若當月不足30筆，自動往前補前1~2個月。
  for (const w of config.watchlist) {
    const hist = await history30(w.code, now);
    const latest = hist.at(-1) || {};
    const price = latest.close ?? null;
    const change = latest.change ?? null;
    const prev = (price!=null && change!=null) ? price-change : null;
    const changePct = (prev && change!=null) ? change/prev*100 : null;
    const trend = trendCalc(hist);

    const s = {...w,
      priceDate: latest.date || null,
      price,
      change,
      changePct,
      open: latest.open ?? null,
      high: latest.high ?? null,
      low: latest.low ?? null,
      volume: latest.volume ?? null,
      turnover: latest.turnover ?? null,
      trend30: trend,
      _hist: hist
    };
    out.push(s);
    await sleep(80);
  }

  // 以實際抓到的最新 STOCK_DAY 日期作為法人查詢日期，而不是用「今天」硬填。
  const dateCounts = new Map();
  for (const s of out) if (s.priceDate) dateCounts.set(s.priceDate,(dateCounts.get(s.priceDate)||0)+1);
  const tradingDate = [...dateCounts.entries()].sort((a,b)=>b[1]-a[1] || b[0].localeCompare(a[0]))[0]?.[0] || null;
  const instPayload = tradingDate ? await t86(tradingDate.replaceAll("-","")).catch(()=>({fields:[],data:[]})) : {fields:[],data:[]};
  const imap = t86Map(instPayload);

  for (const s of out) {
    const ir = imap.get(s.code);
    if (ir) {
      s.institutional = {...ir, estimatedFlowM:(ir.total!=null && s.price!=null) ? ir.total*s.price/1e6 : null};
    } else {
      s.institutional = {foreign:null,trust:null,dealer:null,total:null,estimatedFlowM:null};
    }

    let div={cash:null,exDate:null,payDate:null,yield:null};
    if (s.type === "stock") {
      const candidates=divRows.filter(x=>String(field(x,["公司代號","CompanyCode","公司代碼"])||"").trim()===s.code);
      const d=candidates.at(-1);
      if(d){
        div.cash=num(field(d,["股東配發-盈餘分配之現金股利(元/股)","現金股利","CashDividend"]));
        div.exDate=field(d,["除權息交易日","除息交易日"])||null;
        div.payDate=field(d,["現金股利發放日","發放日"])||null;
      }
    } else {
      const ed=await etfDividend(s.code);
      if(ed) div={...div,...ed};
    }
    if(div.cash!=null && s.price) div.yield=div.cash/s.price*100;
    s.dividend=div;
    s.risk=riskCalc(s, s._hist || []);
    delete s._hist;
  }

  const anyPrice=out.some(s=>s.price!=null);
  const anyInst=out.some(s=>s.institutional.total!=null);
  const dates=[...new Set(out.map(s=>s.priceDate).filter(Boolean))];
  const mixedDates=dates.length>1;
  const result={
    updatedAt:new Date().toISOString(),
    tradingDate: tradingDate,
    priceDates: dates,
    status:anyPrice ? (mixedDates ? "部分個股資料日期不同" : (anyInst ? "收盤與法人資料已更新" : "收盤已更新・等待法人資料")) : "等待交易所資料",
    source:"TWSE 官方公開資料（STOCK_DAY / T86）",
    stocks:out
  };
  fs.writeFileSync("data/latest.json",JSON.stringify(result,null,2));
  console.log(result.status,result.tradingDate,`stocks=${out.length}`);
})().catch(e=>{console.error(e);process.exit(1)});
