const fs = require("fs");
const config = JSON.parse(fs.readFileSync("config.json","utf8"));
const TZ = "Asia/Taipei";
const ymd = (d=new Date()) => new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
const ymdCompact = d => ymd(d).replaceAll("-","");
const num = x => {
  if (x===null || x===undefined || x==="" || x==="--") return null;
  const n=Number(String(x).replaceAll(",","").replace(/[+X]/g,"").trim());
  return Number.isFinite(n)?n:null;
};
async function getJSON(url){
  const r=await fetch(url,{headers:{"User-Agent":"FlowDiv/1.0 personal dashboard"}});
  if(!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function latestPrices(){
  return await getJSON("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
}
async function t86(date){
  const url=`https://www.twse.com.tw/rwd/zh/fund/T86?date=${date}&selectType=ALLBUT0999&response=json`;
  const j=await getJSON(url);
  return j.data||[];
}
async function history(code,date){
  const url=`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${date}&stockNo=${encodeURIComponent(code)}&response=json`;
  const j=await getJSON(url);
  if(!j.data || !j.fields) return [];
  const ix = Object.fromEntries(j.fields.map((x,i)=>[x,i]));
  const pick=(r,names)=>{for(const k of names) if(ix[k]!==undefined) return r[ix[k]]; return null};
  return j.data.map(r=>({
    date:pick(r,["日期"]),
    volume:num(pick(r,["成交股數"])),
    open:num(pick(r,["開盤價"])),
    high:num(pick(r,["最高價"])),
    low:num(pick(r,["最低價"])),
    close:num(pick(r,["收盤價"])),
    change:num(pick(r,["漲跌價差"]))
  })).filter(x=>x.close!=null);
}
function field(row, names){
  for(const n of names) if(Object.prototype.hasOwnProperty.call(row,n)) return row[n];
  return null;
}
function riskCalc(s,hist){
  if(s.price==null) return {score:null,level:"等待資料",reasons:[]};
  let score=10,reasons=[];
  const pct=Math.abs(s.changePct||0);
  if(pct>=7){score+=22;reasons.push("單日漲跌幅很大")}
  else if(pct>=4){score+=15;reasons.push("單日波動偏大")}
  else if(pct>=2){score+=7}
  if(s.high!=null && s.low!=null && s.price){
    const prev=s.price-(s.change||0);
    const amp=prev?((s.high-s.low)/prev*100):0;
    if(amp>=7){score+=18;reasons.push("日內振幅偏高")}
    else if(amp>=4){score+=10;reasons.push("日內振幅擴大")}
    if(s.changePct<0 && s.high>s.low){
      const pos=(s.price-s.low)/(s.high-s.low);
      if(pos<0.2){score+=10;reasons.push("下跌且收盤接近日低")}
    }
  }
  const vols=hist.slice(-20).map(x=>x.volume).filter(Number.isFinite);
  if(vols.length>=5 && s.volume){
    const avg=vols.reduce((a,b)=>a+b,0)/vols.length;
    const vr=s.volume/avg;
    if(vr>=2){score+=15;reasons.push(`成交量約 ${vr.toFixed(1)} 倍近期均量`)}
    else if(vr>=1.4){score+=8;reasons.push("成交量明顯放大")}
  }
  const total=s.institutional?.total;
  if(Number.isFinite(total) && s.volume){
    const r=total/s.volume;
    if(r<=-0.15){score+=18;reasons.push("法人賣超占成交量比重高")}
    else if(r<=-0.07){score+=10;reasons.push("法人籌碼偏流出")}
    if(r>=0.15 && score>10){score-=5}
  }
  score=Math.max(0,Math.min(100,Math.round(score)));
  const level=score>=71?"高":score>=51?"偏高":score>=31?"留意":"穩定";
  if(!reasons.length) reasons.push("今日未見明顯異常交易訊號");
  return {score,level,reasons};
}
async function stockDividends(){
  try{return await getJSON("https://openapi.twse.com.tw/v1/opendata/t187ap45_L")}catch(e){return []}
}
async function etfDividend(code){
  try{
    const r=await fetch(`https://www.twse.com.tw/zh/ETFortune-institute/dividendList?stkNo=${encodeURIComponent(code)}`,{headers:{"User-Agent":"FlowDiv/1.0 personal dashboard"}});
    const txt=await r.text();
    // HTML is intentionally treated as fallback. Find the first row containing the code,
    // then collect dates and a decimal dividend from nearby plain text.
    const plain=txt.replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ");
    const i=plain.indexOf(code);
    if(i<0)return null;
    const chunk=plain.slice(i,i+700);
    const dates=[...chunk.matchAll(/(20\d{2})[\/-](\d{2})[\/-](\d{2})/g)].map(m=>`${m[1]}-${m[2]}-${m[3]}`);
    const nums=[...chunk.matchAll(/\s(\d+(?:\.\d+)?)\s/g)].map(m=>Number(m[1])).filter(n=>n>0&&n<50);
    return {exDate:dates[0]||null,payDate:dates[2]||dates[1]||null,cash:nums[0]||null};
  }catch(e){return null}
}
(async()=>{
  const now=new Date(), today=ymdCompact(now);
  const [prices,instRows,divRows]=await Promise.all([latestPrices(),t86(today).catch(()=>[]),stockDividends()]);
  const pmap=new Map(prices.map(r=>[String(field(r,["Code","證券代號","股票代號"])).trim(),r]));
  const imap=new Map(instRows.map(r=>[String(r[0]).trim(),r]));
  const out=[];
  for(const w of config.watchlist){
    const r=pmap.get(w.code)||{};
    const price=num(field(r,["ClosingPrice","收盤價"]));
    const change=num(field(r,["Change","漲跌價差"]));
    const prev=(price!=null&&change!=null)?price-change:null;
    const changePct=(prev&&change!=null)?change/prev*100:null;
    const s={...w,
      price,change,changePct,
      open:num(field(r,["OpeningPrice","開盤價"])),
      high:num(field(r,["HighestPrice","最高價"])),
      low:num(field(r,["LowestPrice","最低價"])),
      volume:num(field(r,["TradeVolume","成交股數"])),
      turnover:num(field(r,["TradeValue","成交金額"]))
    };
    const ir=imap.get(w.code);
    if(ir){
      const foreign=num(ir[4]), trust=num(ir[10]), dealer=num(ir[11]), total=num(ir[18]);
      s.institutional={foreign,trust,dealer,total,estimatedFlowM:(total!=null&&price!=null)?total*price/1e6:null};
    }else s.institutional={foreign:null,trust:null,dealer:null,total:null,estimatedFlowM:null};
    let div={cash:null,exDate:null,payDate:null,yield:null};
    if(w.type==="stock"){
      const candidates=divRows.filter(x=>String(field(x,["公司代號","CompanyCode","公司代碼"])||"").trim()===w.code);
      const d=candidates.at(-1);
      if(d){
        div.cash=num(field(d,["股東配發-盈餘分配之現金股利(元/股)","現金股利","CashDividend"]));
        div.exDate=field(d,["除權息交易日","除息交易日"])||null;
        div.payDate=field(d,["現金股利發放日","發放日"])||null;
      }
    }else{
      const ed=await etfDividend(w.code);
      if(ed) div={...div,...ed};
    }
    if(div.cash!=null && price) div.yield=div.cash/price*100;
    s.dividend=div;
    const hist=await history(w.code,today).catch(()=>[]);
    s.risk=riskCalc(s,hist);
    out.push(s);
  }
  const anyPrice=out.some(s=>s.price!=null), anyInst=out.some(s=>s.institutional.total!=null);
  const result={
    updatedAt:new Date().toISOString(),
    tradingDate:anyPrice?ymd(now):null,
    status:anyPrice?(anyInst?"收盤與法人資料已更新":"收盤已更新・等待法人資料"):"等待交易所資料",
    source:"TWSE 官方公開資料",
    stocks:out
  };
  fs.writeFileSync("data/latest.json",JSON.stringify(result,null,2));
  console.log(result.status,result.tradingDate);
})().catch(e=>{console.error(e);process.exit(1)});
