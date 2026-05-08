/* =========================================================================
 * 쿠팡 납품률 · 미출고 관리 - 단일 페이지 SPA
 * ------------------------------------------------------------------------
 * - 엑셀 업로드(여러 파일/여러 시트) → 발주일자 기준 자동 월 분류
 * - localStorage 영속 (브라우저 닫아도 유지)
 * - 대시보드 / 사유별 / 상품별 / 상세검색 / 데이터관리
 * ========================================================================= */

(() => {
  /* ---------- 상수 / 헬퍼 ---------- */
  const STORE_KEY = "coupang-fulfillment-v1";
  const COLS = ["발주일자","발주번호","상품명","모델명","발주수량","실제출고량","미출고수량","미출고 금액","미출고사유","비고","매입가","공급가"];
  const HEADER_SYNONYMS = {
    // 발주일자 (관리용 양식 전용 — PO 양식의 발주등록일시/입고예정일 등은 매핑 안 함, 파일 수정시간 사용)
    "발주일자":"발주일자","발주일":"발주일자","주문일자":"발주일자",
    // 발주번호
    "발주번호":"발주번호","발주ID":"발주번호","주문번호":"발주번호","발주 번호":"발주번호","PO번호":"발주번호",
    // 상품명
    "상품명":"상품명","옵션명":"상품명","상품 명":"상품명","상품이름":"상품명","상품 이름":"상품명",
    // 모델명
    "모델명":"모델명","모델 명":"모델명","모델":"모델명","SKU":"모델명","sku":"모델명","상품번호":"모델명","상품바코드":"모델명",
    // 발주수량
    "발주수량":"발주수량","주문수량":"발주수량","발주 수량":"발주수량",
    // 실제출고량
    "실제출고량":"실제출고량","출고수량":"실제출고량","출고량":"실제출고량","실 출고":"실제출고량","실출고":"실제출고량","실출고량":"실제출고량","확정수량":"실제출고량","납품수량":"실제출고량",
    // 미출고수량
    "미출고수량":"미출고수량","미출고 수량":"미출고수량","결품수량":"미출고수량","납품부족수량":"미출고수량",
    // 미출고 금액
    "미출고 금액":"미출고 금액","미출고금액":"미출고 금액","결품금액":"미출고 금액",
    // 미출고사유
    "미출고사유":"미출고사유","미출고 사유":"미출고사유","결품사유":"미출고사유","사유":"미출고사유","납품부족사유":"미출고사유","납품부족 사유":"미출고사유",
    // 비고
    "비고":"비고","메모":"비고","코멘트":"비고",
    // 단가 (자동 계산용)
    "매입가":"매입가","단가":"매입가","원가":"매입가",
    "공급가":"공급가","공급단가":"공급가",
  };

  const fmtN = n => (n==null||isNaN(n))?"-":Number(n).toLocaleString("ko-KR");
  const fmtW = n => (n==null||isNaN(n))?"-":"₩"+Number(n).toLocaleString("ko-KR");
  const pct = n => (n==null||isNaN(n)||!isFinite(n))?"-":(n*100).toFixed(1)+"%";
  const ymKey = d => `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,"0")}월`;
  const ymdKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const escapeHtml = s => String(s??"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const $ = (q,el=document)=>el.querySelector(q);
  const $$ = (q,el=document)=>[...el.querySelectorAll(q)];
  const debounce = (fn,ms=200)=>{let t;return (...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}};
  const toast = (msg, type="ok") => {
    const el = $("#toast"); el.textContent = msg; el.className = "toast show "+type;
    setTimeout(()=>el.className="toast",2400);
  };

  /* ---------- 사유 색상/라벨 ---------- */
  const REASON_PALETTE = ["#f85149","#d29922","#58a6ff","#3fb950","#ba83f2","#ff5a1f","#7ee2cc","#f0a8c5","#a6c0ff","#ffd166"];
  const reasonClassMap = new Map();
  function reasonClass(r){
    if(!reasonClassMap.has(r)) reasonClassMap.set(r,"s"+(reasonClassMap.size%6+1));
    return reasonClassMap.get(r);
  }
  function reasonColor(r, list){
    const idx = list.indexOf(r);
    return REASON_PALETTE[idx % REASON_PALETTE.length];
  }

  /* ---------- 상태 ---------- */
  const State = {
    rows: [],            // 모든 미출고 행
    files: [],           // 업로드 메타 [{name,size,addedAt,rowCount}]
    period: "all",       // "all" | "YYYY.MM월"
    activeTab: "dashboard",
    detailFilter: { q:"", reason:"", from:"", to:"", sort:"발주일자", dir:"desc", page:1, pageSize:50 },
    charts: {},          // Chart.js 인스턴스
  };

  function save(){
    try{
      localStorage.setItem(STORE_KEY, JSON.stringify({rows:State.rows,files:State.files}));
    }catch(e){
      console.error(e);
      toast("저장 용량을 초과했습니다. 일부 파일을 삭제해 주세요.","err");
    }
  }
  function load(){
    try{
      const s = localStorage.getItem(STORE_KEY); if(!s) return;
      const p = JSON.parse(s);
      State.rows = (p.rows||[]).map(r=>({...r, 발주일자: r.발주일자 ? new Date(r.발주일자) : null}));
      State.files = p.files||[];
    }catch(e){ console.error(e); }
  }

  /* ---------- 엑셀 파싱 ---------- */
  function normalizeHeader(h){
    if(h==null) return "";
    // 보이지 않는 문자 정리 (NBSP, ZWS, ZWNJ, ZWJ, BOM)
    let k = String(h).replace(/[ ​‌‍﻿]/g, "")
                     .replace(/\s+/g, " ").trim();
    if(HEADER_SYNONYMS[k]) return HEADER_SYNONYMS[k];
    // 공백 모두 제거 후 재시도
    const k2 = k.replace(/\s/g, "");
    if(HEADER_SYNONYMS[k2]) return HEADER_SYNONYMS[k2];
    return k;
  }

  function parseDate(v){
    if(v==null||v==="") return null;
    if(v instanceof Date && !isNaN(v)) return v;
    if(typeof v === "number"){
      // YYYYMMDD 정수 형식 (예: 20260506)
      if(Number.isInteger(v) && v >= 19000101 && v <= 21001231){
        const s = String(v); const yy=+s.slice(0,4), mm=+s.slice(4,6), dd=+s.slice(6,8);
        if(mm>=1 && mm<=12 && dd>=1 && dd<=31) return new Date(yy, mm-1, dd);
      }
      // Excel serial date
      const d = XLSX.SSF.parse_date_code(v);
      if(d) return new Date(d.y, d.m-1, d.d, d.H||0, d.M||0, d.S||0);
    }
    if(typeof v === "string"){
      const s = v.trim();
      // YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
      let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
      if(m) return new Date(+m[1], +m[2]-1, +m[3]);
      // YYYYMMDD 문자열 (예: "20260506")
      m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
      if(m){ const yy=+m[1], mm=+m[2], dd=+m[3];
        if(mm>=1&&mm<=12&&dd>=1&&dd<=31) return new Date(yy, mm-1, dd); }
      const d = new Date(s); return isNaN(d) ? null : d;
    }
    return null;
  }

  function num(v){
    if(v==null||v==="") return 0;
    if(typeof v === "number") return v;
    const n = Number(String(v).replace(/[,\s₩]/g,""));
    return isNaN(n) ? 0 : n;
  }

  async function readWorkbook(file){
    const buf = await file.arrayBuffer();
    return XLSX.read(buf, { cellDates:true });
  }

  function rowsFromSheet(ws, sheetName, fileName){
    const aoa = XLSX.utils.sheet_to_json(ws, { header:1, defval:null, raw:true });
    if(!aoa.length) return [];
    // 헤더 행 찾기 (첫 5행 안에서 "발주번호" 또는 "발주일자")
    let headerIdx = -1;
    for(let i=0;i<Math.min(5,aoa.length);i++){
      const norm = aoa[i].map(normalizeHeader);
      if(norm.includes("발주번호") || norm.includes("발주일자")){ headerIdx=i; break; }
    }
    if(headerIdx<0) return [];
    const headers = aoa[headerIdx].map(normalizeHeader);
    const idx = {};
    COLS.forEach(c=>{ idx[c] = headers.indexOf(c); });

    const out = [];
    const has = (k,row) => idx[k]>=0 && row[idx[k]]!=null && row[idx[k]]!=="";

    for(let r=headerIdx+1;r<aoa.length;r++){
      const row = aoa[r]; if(!row) continue;
      // 발주일자: 명시 컬럼이 있으면 그 값만 사용. 없거나 파싱 실패면 null로 두고 ingestFiles에서 파일 수정 시간으로 fallback
      const d = parseDate(idx["발주일자"]>=0 ? row[idx["발주일자"]] : null);
      const po = idx["발주번호"]>=0 ? row[idx["발주번호"]] : null;
      const name = idx["상품명"]>=0 ? row[idx["상품명"]] : null;
      // 데이터 없는 행은 skip
      if(!d && !po && !name) continue;

      const ord  = num(has("발주수량",row)  ? row[idx["발주수량"]]  : 0);
      const ship = num(has("실제출고량",row) ? row[idx["실제출고량"]] : 0);
      const price = num(has("매입가",row) ? row[idx["매입가"]] : (has("공급가",row) ? row[idx["공급가"]] : 0));
      const reason = has("미출고사유",row) ? String(row[idx["미출고사유"]]).trim() : "";

      // 미출고수량: 명시 컬럼 있으면 그 값, 없으면 발주-출고로 자동 계산
      let unship = has("미출고수량",row) ? num(row[idx["미출고수량"]])
                                        : Math.max(0, ord - ship);
      // 미출고 금액: 명시 컬럼 있으면 그 값, 없으면 미출고수량 × 매입가
      let amt = has("미출고 금액",row) ? num(row[idx["미출고 금액"]])
                                       : unship * price;

      // 정상 출고 라인(미출고 0 + 사유 없음)은 노이즈이므로 제외
      // 단, 명시 컬럼이 있는 양식(우리 관리 양식)은 이 조건이 거의 발생 안 함
      if(unship === 0 && !reason) continue;

      out.push({
        발주일자: d ? d.toISOString() : null,
        발주번호: po==null ? "" : String(po).replace(/\.0$/,""),
        상품명:   name==null ? "" : String(name),
        모델명:   idx["모델명"]>=0 && row[idx["모델명"]]!=null ? String(row[idx["모델명"]]) : "",
        발주수량:  ord,
        실제출고량: ship,
        미출고수량: unship,
        "미출고 금액": amt,
        미출고사유: reason,
        비고:      idx["비고"]>=0 && row[idx["비고"]]!=null ? String(row[idx["비고"]]) : "",
        매입가:    price,
        _src:     `${fileName} / ${sheetName}`
      });
    }
    return out;
  }

  function rowKey(r){
    return [r.발주번호, r.상품명, r.모델명, r.발주수량, r.미출고수량, r.발주일자].join("§");
  }

  async function ingestFiles(fileList){
    const newRows = [];
    const fileMeta = [];
    for(const f of fileList){
      try{
        const wb = await readWorkbook(f);
        // 파일 자체의 수정/생성 시각 — 행 단위 매핑 실패 시 최종 fallback
        const fileMtime = new Date(f.lastModified || Date.now());
        let added=0;
        for(const sn of wb.SheetNames){
          const got = rowsFromSheet(wb.Sheets[sn], sn, f.name);
          // 발주일자가 없는 행은 파일의 수정 날짜로 자동 채움
          for(const r of got){
            if(!r.발주일자){
              r.발주일자 = fileMtime.toISOString();
              r._dateFromFile = true;  // "파일 날짜로 보정됨" 표시
            }
          }
          newRows.push(...got);
          added += got.length;
        }
        fileMeta.push({ name:f.name, size:f.size, addedAt:new Date().toISOString(), rowCount:added, mtime:fileMtime.toISOString() });
      }catch(e){
        console.error(e);
        toast(`파일 읽기 실패: ${f.name}`, "err");
      }
    }
    // 중복 제거 (기존 + 신규)
    const seen = new Set(State.rows.map(rowKey));
    let added = 0;
    for(const r of newRows){
      const k = rowKey(r);
      if(!seen.has(k)){ State.rows.push(r); seen.add(k); added++; }
    }
    State.files.push(...fileMeta);
    save();
    toast(`${fileList.length}개 파일 처리 완료 · ${added}건 추가 (중복 ${newRows.length-added}건 제외)`, "ok");
    rebuildPeriods();
    render();
  }

  /* ---------- 집계 ---------- */
  function rowsForPeriod(){
    if(State.period==="all") return State.rows;
    return State.rows.filter(r=>{
      if(!r.발주일자) return false;
      const d = new Date(r.발주일자);
      return ymKey(d) === State.period;
    });
  }
  function getPeriods(){
    const set = new Set();
    for(const r of State.rows){
      if(r.발주일자) set.add(ymKey(new Date(r.발주일자)));
    }
    return [...set].sort();
  }
  function aggMonthly(rows){
    const m = new Map();
    for(const r of rows){
      if(!r.발주일자) continue;
      const k = ymKey(new Date(r.발주일자));
      if(!m.has(k)) m.set(k,{period:k, count:0, qty:0, amt:0});
      const o = m.get(k); o.count++; o.qty+=r.미출고수량||0; o.amt+=r["미출고 금액"]||0;
    }
    return [...m.values()].sort((a,b)=>a.period.localeCompare(b.period));
  }
  function aggReasons(rows){
    const m = new Map();
    for(const r of rows){
      const k = (r.미출고사유||"미분류").trim() || "미분류";
      if(!m.has(k)) m.set(k,{reason:k, count:0, qty:0, amt:0});
      const o = m.get(k); o.count++; o.qty+=r.미출고수량||0; o.amt+=r["미출고 금액"]||0;
    }
    return [...m.values()].sort((a,b)=>b.amt-a.amt);
  }
  function aggDaily(rows){
    const m = new Map();
    for(const r of rows){
      if(!r.발주일자) continue;
      const d = new Date(r.발주일자);
      const k = ymdKey(d);
      if(!m.has(k)) m.set(k,{date:k, count:0, qty:0, amt:0});
      const o = m.get(k); o.count++; o.qty+=r.미출고수량||0; o.amt+=r["미출고 금액"]||0;
    }
    return [...m.values()].sort((a,b)=>a.date.localeCompare(b.date));
  }
  function aggProducts(rows, n=20){
    const m = new Map();
    for(const r of rows){
      const key = (r.모델명||"").trim() ? r.모델명 : (r.상품명||"").slice(0,80);
      if(!m.has(key)) m.set(key,{key, name:r.상품명, model:r.모델명, count:0, qty:0, amt:0, reasons:{}});
      const o = m.get(key); o.count++; o.qty+=r.미출고수량||0; o.amt+=r["미출고 금액"]||0;
      const reason = (r.미출고사유||"미분류").trim()||"미분류";
      o.reasons[reason] = (o.reasons[reason]||0) + 1;
    }
    return [...m.values()].sort((a,b)=>b.amt-a.amt).slice(0, n);
  }
  function aggReasonByMonth(rows){
    const months = [...new Set(rows.filter(r=>r.발주일자).map(r=>ymKey(new Date(r.발주일자))))].sort();
    const reasons = [...new Set(rows.map(r=>(r.미출고사유||"미분류").trim()||"미분류"))];
    const matrix = {}; // {reason: {month: {count, qty, amt}}}
    for(const r of reasons) matrix[r] = Object.fromEntries(months.map(m=>[m,{count:0,qty:0,amt:0}]));
    for(const r of rows){
      if(!r.발주일자) continue;
      const m = ymKey(new Date(r.발주일자));
      const k = (r.미출고사유||"미분류").trim()||"미분류";
      const cell = matrix[k][m]; cell.count++; cell.qty+=r.미출고수량||0; cell.amt+=r["미출고 금액"]||0;
    }
    return { months, reasons, matrix };
  }

  /* ---------- 차트 ---------- */
  function destroyChart(id){ if(State.charts[id]){ State.charts[id].destroy(); delete State.charts[id]; } }
  Chart.defaults.color = "#9aa4b2";
  Chart.defaults.borderColor = "#2a313c";
  Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,Pretendard,Apple SD Gothic Neo,Segoe UI,sans-serif";

  /* ---------- 렌더링 ---------- */
  function rebuildPeriods(){
    const periods = getPeriods();
    const sel = $("#periodSelect");
    sel.innerHTML = `<option value="all">전체 기간</option>` +
      periods.map(p=>`<option value="${p}">${p}</option>`).join("");
    if(!periods.includes(State.period)) State.period = "all";
    sel.value = State.period;
    // 데이터 상태
    const ds = $("#dataStatus");
    if(State.rows.length){
      ds.classList.add("ok");
      ds.textContent = `${State.rows.length.toLocaleString()}건 · ${periods.length}개월 · ${State.files.length}개 파일`;
    }else{
      ds.classList.remove("ok");
      ds.textContent = "데이터 없음 · 엑셀을 업로드하세요";
    }
  }

  function render(){
    rebuildPeriods();
    const main = $("#main");
    if(!State.rows.length && State.activeTab !== "manage"){
      main.innerHTML = renderEmpty();
      bindEmpty();
      return;
    }
    switch(State.activeTab){
      case "dashboard": main.innerHTML = renderDashboard(); afterDashboard(); break;
      case "reasons":   main.innerHTML = renderReasons();   afterReasons(); break;
      case "products":  main.innerHTML = renderProducts();  afterProducts(); break;
      case "detail":    main.innerHTML = renderDetail();    afterDetail(); break;
      case "manage":    main.innerHTML = renderManage();    afterManage(); break;
    }
  }

  function renderEmpty(){
    return `
      <div class="empty">
        <h2>업로드된 데이터가 없습니다</h2>
        <p>쿠팡 발주/미출고 엑셀 파일을 업로드하면 자동으로 월별 분류 · 사유별 집계가 됩니다.</p>
        <div style="max-width:560px;margin:24px auto 0">
          <div id="dropZone" class="drop">
            <div style="font-size:36px;line-height:1">📥</div>
            <div style="margin-top:8px"><b>엑셀 파일을 여기에 드롭</b>하거나 <span style="color:var(--brand);cursor:pointer" onclick="document.getElementById('fileInput').click()">파일 선택</span></div>
            <div class="sm" style="margin-top:8px">.xlsx · .xlsm · .xls · 여러 파일 동시 가능</div>
          </div>
        </div>
      </div>
    `;
  }
  function bindEmpty(){
    const dz = $("#dropZone"); if(!dz) return;
    dz.addEventListener("dragover", e=>{e.preventDefault();dz.classList.add("hover")});
    dz.addEventListener("dragleave", ()=>dz.classList.remove("hover"));
    dz.addEventListener("drop", e=>{
      e.preventDefault();dz.classList.remove("hover");
      ingestFiles([...e.dataTransfer.files]);
    });
  }

  /* ===== 대시보드 ===== */
  function renderDashboard(){
    const rows = rowsForPeriod();
    const allMonthly = aggMonthly(State.rows);
    const cur = State.period==="all" ? null : State.period;
    let kpiNow={count:0,qty:0,amt:0}, kpiPrev={count:0,qty:0,amt:0};
    if(cur){
      const idx = allMonthly.findIndex(m=>m.period===cur);
      kpiNow = idx>=0 ? allMonthly[idx] : kpiNow;
      kpiPrev = idx>0 ? allMonthly[idx-1] : kpiPrev;
    }else{
      // 전체 기간 합계 — 발주일자 유무와 무관하게 모든 행 합산
      kpiNow = State.rows.reduce((a,r)=>({
        period:"전체",
        count: a.count + 1,
        qty:   a.qty + (r.미출고수량||0),
        amt:   a.amt + (r["미출고 금액"]||0)
      }), {count:0,qty:0,amt:0});
    }
    const dly = aggDaily(rows);
    const reasonsAgg = aggReasons(rows);
    const periodLabel = cur || "전체 기간";

    const delta = (now,prev)=>{
      if(!cur) return `<span class="delta flat">—</span>`;
      if(!prev) return `<span class="delta flat">신규</span>`;
      const r = (now-prev)/Math.max(prev,1);
      const cls = r>0?"up":(r<0?"down":"flat");
      const arr = r>0?"▲":(r<0?"▼":"–");
      return `<span class="delta ${cls}">${arr} ${(Math.abs(r)*100).toFixed(1)}% <span class="muted">(전월 ${fmtN(prev)})</span></span>`;
    };

    return `
      <div class="grid cols-4" style="margin-bottom:14px">
        <div class="panel kpi">
          <div class="lbl">${periodLabel} · 미출고 건수</div>
          <div class="val">${fmtN(kpiNow.count)}</div>
          ${delta(kpiNow.count, kpiPrev.count)}
        </div>
        <div class="panel kpi">
          <div class="lbl">미출고 수량</div>
          <div class="val">${fmtN(kpiNow.qty)}</div>
          ${delta(kpiNow.qty, kpiPrev.qty)}
        </div>
        <div class="panel kpi">
          <div class="lbl">미출고 금액</div>
          <div class="val" style="color:var(--brand-2)">${fmtW(kpiNow.amt)}</div>
          ${delta(kpiNow.amt, kpiPrev.amt)}
        </div>
        <div class="panel kpi">
          <div class="lbl">평균 건당 손실</div>
          <div class="val">${fmtW(kpiNow.count?kpiNow.amt/kpiNow.count:0)}</div>
          <span class="delta flat">${fmtN(kpiNow.qty/Math.max(kpiNow.count,1))} 개/건</span>
        </div>
      </div>

      <div class="grid cols-2" style="margin-bottom:14px">
        <div class="panel">
          <h3>월별 추이</h3>
          <div class="chart-box"><canvas id="chMonthly"></canvas></div>
        </div>
        <div class="panel">
          <h3>${periodLabel} · 사유 분포</h3>
          <div class="chart-box"><canvas id="chReasonsDonut"></canvas></div>
        </div>
      </div>

      <div class="panel" style="margin-bottom:14px">
        <h3>일별 추이 ${cur?`(${cur})`:""}</h3>
        <div class="chart-box tall"><canvas id="chDaily"></canvas></div>
      </div>

      <div class="grid cols-2">
        <div class="panel">
          <h3>사유별 요약</h3>
          <table class="t">
            <thead><tr><th>사유</th><th class="num">건수</th><th class="num">수량</th><th class="num">금액</th><th class="num">비중</th></tr></thead>
            <tbody>
              ${reasonsAgg.map(r=>`
                <tr>
                  <td><span class="pill ${reasonClass(r.reason)}">${escapeHtml(r.reason)}</span></td>
                  <td class="num">${fmtN(r.count)}</td>
                  <td class="num">${fmtN(r.qty)}</td>
                  <td class="num">${fmtW(r.amt)}</td>
                  <td class="num">${pct(r.amt/Math.max(reasonsAgg.reduce((a,b)=>a+b.amt,0),1))}</td>
                </tr>`).join("")}
              <tr class="totalrow">
                <td>합계</td>
                <td class="num">${fmtN(reasonsAgg.reduce((a,b)=>a+b.count,0))}</td>
                <td class="num">${fmtN(reasonsAgg.reduce((a,b)=>a+b.qty,0))}</td>
                <td class="num">${fmtW(reasonsAgg.reduce((a,b)=>a+b.amt,0))}</td>
                <td class="num">100.0%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="panel">
          <h3>${periodLabel} · 손실 TOP 10 상품</h3>
          <table class="t">
            <thead><tr><th>상품/모델</th><th class="num">건수</th><th class="num">수량</th><th class="num">금액</th></tr></thead>
            <tbody>
              ${aggProducts(rows,10).map(p=>`
                <tr>
                  <td><span class="truncate" title="${escapeHtml(p.name||p.key)}"><b>${escapeHtml(p.model||"")}</b> ${escapeHtml(p.name||"")}</span></td>
                  <td class="num">${fmtN(p.count)}</td>
                  <td class="num">${fmtN(p.qty)}</td>
                  <td class="num">${fmtW(p.amt)}</td>
                </tr>`).join("") || `<tr><td colspan="4" class="muted">데이터 없음</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
  function afterDashboard(){
    const allMonthly = aggMonthly(State.rows);
    const rows = rowsForPeriod();
    const reasonsAgg = aggReasons(rows);
    const dly = aggDaily(rows);

    destroyChart("chMonthly");
    State.charts.chMonthly = new Chart($("#chMonthly"),{
      type:"bar",
      data:{
        labels: allMonthly.map(m=>m.period),
        datasets:[
          {label:"미출고 금액", data:allMonthly.map(m=>m.amt), backgroundColor:"rgba(255,90,31,.6)", borderColor:"#ff5a1f", borderWidth:1, yAxisID:"y", order:2},
          {label:"미출고 수량", data:allMonthly.map(m=>m.qty), type:"line", borderColor:"#58a6ff", backgroundColor:"#58a6ff", tension:.3, yAxisID:"y2", order:1, pointRadius:3},
        ]
      },
      options:{
        maintainAspectRatio:false, responsive:true,
        plugins:{ legend:{position:"bottom"} },
        scales:{
          y:{ ticks:{callback:v=>"₩"+(v/10000).toFixed(0)+"만"} },
          y2:{ position:"right", grid:{drawOnChartArea:false}, ticks:{callback:v=>v.toLocaleString()} }
        }
      }
    });

    destroyChart("chReasonsDonut");
    State.charts.chReasonsDonut = new Chart($("#chReasonsDonut"),{
      type:"doughnut",
      data:{
        labels: reasonsAgg.map(r=>r.reason),
        datasets:[{
          data: reasonsAgg.map(r=>r.amt),
          backgroundColor: reasonsAgg.map((r,i)=>REASON_PALETTE[i%REASON_PALETTE.length]),
          borderColor:"#161b22", borderWidth:2
        }]
      },
      options:{
        maintainAspectRatio:false, responsive:true, cutout:"60%",
        plugins:{
          legend:{position:"right", labels:{boxWidth:12}},
          tooltip:{callbacks:{label:c=>`${c.label}: ${fmtW(c.parsed)}`}}
        }
      }
    });

    destroyChart("chDaily");
    State.charts.chDaily = new Chart($("#chDaily"),{
      type:"bar",
      data:{
        labels: dly.map(d=>d.date.slice(5)),
        datasets:[
          {label:"미출고 건수", data:dly.map(d=>d.count), backgroundColor:"rgba(88,166,255,.6)", yAxisID:"y"},
          {label:"미출고 금액(만원)", data:dly.map(d=>d.amt/10000), type:"line", borderColor:"#ff5a1f", backgroundColor:"#ff5a1f", tension:.25, yAxisID:"y2", pointRadius:3},
        ]
      },
      options:{
        maintainAspectRatio:false, responsive:true,
        plugins:{legend:{position:"bottom"}},
        scales:{
          y:{ticks:{callback:v=>v.toLocaleString()}},
          y2:{position:"right", grid:{drawOnChartArea:false}, ticks:{callback:v=>v+"만"}}
        }
      }
    });
  }

  /* ===== 사유별 분석 ===== */
  function renderReasons(){
    const rows = rowsForPeriod();
    const all = State.rows;
    const m = aggReasonByMonth(all);
    const totalAmt = aggReasons(rows).reduce((a,b)=>a+b.amt,0);
    const cur = aggReasons(rows);
    const max = Math.max(...m.reasons.map(r=>m.months.reduce((a,mo)=>a+m.matrix[r][mo].amt,0)),1);

    return `
      <div class="grid cols-2" style="margin-bottom:14px">
        <div class="panel">
          <h3>사유 × 월 — 미출고 금액 매트릭스 (전체 기간)</h3>
          <div style="overflow:auto">
          <table class="t matrix">
            <thead><tr><th>사유</th>${m.months.map(mo=>`<th class="num">${mo}</th>`).join("")}<th class="num">합계</th></tr></thead>
            <tbody>
              ${m.reasons.map(r=>{
                const total = m.months.reduce((a,mo)=>a+m.matrix[r][mo].amt,0);
                return `<tr>
                  <td><span class="pill ${reasonClass(r)}">${escapeHtml(r)}</span></td>
                  ${m.months.map(mo=>{
                    const v = m.matrix[r][mo].amt;
                    const w = v/Math.max(...m.months.map(mm=>m.matrix[r][mm].amt),1);
                    return `<td class="num heat" style="--w:${(v/max)*1.5}">${v?fmtW(v):"<span class='muted'>-</span>"}</td>`;
                  }).join("")}
                  <td class="num"><b>${fmtW(total)}</b></td>
                </tr>`;
              }).join("")}
              <tr class="totalrow">
                <td>합계</td>
                ${m.months.map(mo=>{
                  const sum = m.reasons.reduce((a,r)=>a+m.matrix[r][mo].amt,0);
                  return `<td class="num">${fmtW(sum)}</td>`;
                }).join("")}
                <td class="num">${fmtW(m.reasons.reduce((a,r)=>a+m.months.reduce((b,mo)=>b+m.matrix[r][mo].amt,0),0))}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
        <div class="panel">
          <h3>${State.period==="all"?"전체 기간":State.period} · 사유 비중 (금액)</h3>
          <div class="chart-box"><canvas id="chReasonBar"></canvas></div>
        </div>
      </div>

      <div class="panel" style="margin-bottom:14px">
        <h3>사유 비중 추이 (월별, 100% 적층)</h3>
        <div class="chart-box tall"><canvas id="chReasonStacked"></canvas></div>
      </div>

      <div class="grid cols-2">
        ${cur.slice(0,4).map(r=>`
          <div class="panel">
            <h3>『${escapeHtml(r.reason)}』 TOP 10 상품 — ${State.period==="all"?"전체":State.period}</h3>
            <table class="t"><thead><tr><th>상품/모델</th><th class="num">건수</th><th class="num">수량</th><th class="num">금액</th></tr></thead>
            <tbody>
              ${aggProducts(rows.filter(x=>(x.미출고사유||"미분류")===r.reason),10).map(p=>`
                <tr>
                  <td><span class="truncate" title="${escapeHtml(p.name||p.key)}"><b>${escapeHtml(p.model||"")}</b> ${escapeHtml(p.name||"")}</span></td>
                  <td class="num">${fmtN(p.count)}</td>
                  <td class="num">${fmtN(p.qty)}</td>
                  <td class="num">${fmtW(p.amt)}</td>
                </tr>`).join("") || `<tr><td colspan="4" class="muted">데이터 없음</td></tr>`}
            </tbody></table>
          </div>
        `).join("")}
      </div>
    `;
  }
  function afterReasons(){
    const rows = rowsForPeriod();
    const cur = aggReasons(rows);
    destroyChart("chReasonBar");
    State.charts.chReasonBar = new Chart($("#chReasonBar"),{
      type:"bar",
      data:{
        labels: cur.map(r=>r.reason),
        datasets:[{label:"미출고 금액", data:cur.map(r=>r.amt),
          backgroundColor: cur.map((r,i)=>REASON_PALETTE[i%REASON_PALETTE.length])}]
      },
      options:{
        maintainAspectRatio:false, indexAxis:"y", plugins:{legend:{display:false}},
        scales:{x:{ticks:{callback:v=>"₩"+(v/10000).toFixed(0)+"만"}}}
      }
    });

    const rbm = aggReasonByMonth(State.rows);
    destroyChart("chReasonStacked");
    State.charts.chReasonStacked = new Chart($("#chReasonStacked"),{
      type:"bar",
      data:{
        labels: rbm.months,
        datasets: rbm.reasons.map((r,i)=>({
          label:r,
          data: rbm.months.map(mo=>{
            const totalMonth = rbm.reasons.reduce((a,rr)=>a+rbm.matrix[rr][mo].amt,0);
            return totalMonth ? rbm.matrix[r][mo].amt/totalMonth*100 : 0;
          }),
          backgroundColor: REASON_PALETTE[i%REASON_PALETTE.length]
        }))
      },
      options:{
        maintainAspectRatio:false, plugins:{legend:{position:"bottom"}, tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${c.parsed.y.toFixed(1)}%`}}},
        scales:{ x:{stacked:true}, y:{stacked:true, max:100, ticks:{callback:v=>v+"%"}} }
      }
    });
  }

  /* ===== 상품(모델)별 ===== */
  function renderProducts(){
    const rows = rowsForPeriod();
    const list = aggProducts(rows, 50);
    const reasonsAll = [...new Set(State.rows.map(r=>(r.미출고사유||"미분류").trim()||"미분류"))];
    return `
      <div class="panel">
        <h3>${State.period==="all"?"전체 기간":State.period} · 상품(모델)별 미출고 TOP 50</h3>
        <table class="t">
          <thead><tr>
            <th>#</th><th>모델/상품명</th><th class="num">건수</th><th class="num">수량</th>
            <th class="num">금액</th><th>주요 사유</th>
          </tr></thead>
          <tbody>
            ${list.map((p,i)=>{
              const top = Object.entries(p.reasons).sort((a,b)=>b[1]-a[1]).slice(0,3);
              return `<tr>
                <td class="muted">${i+1}</td>
                <td><b>${escapeHtml(p.model||"-")}</b><div class="muted sm truncate" style="max-width:520px" title="${escapeHtml(p.name||"")}">${escapeHtml(p.name||"")}</div></td>
                <td class="num">${fmtN(p.count)}</td>
                <td class="num">${fmtN(p.qty)}</td>
                <td class="num">${fmtW(p.amt)}</td>
                <td>${top.map(([r,c])=>`<span class="pill ${reasonClass(r)}" style="margin-right:4px">${escapeHtml(r)} ${c}</span>`).join("")}</td>
              </tr>`;
            }).join("") || `<tr><td colspan="6" class="muted">데이터 없음</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
  }
  function afterProducts(){}

  /* ===== 상세 검색 ===== */
  function renderDetail(){
    const f = State.detailFilter;
    const reasons = [...new Set(State.rows.map(r=>(r.미출고사유||"미분류").trim()||"미분류"))].sort();
    return `
      <div class="panel" style="margin-bottom:14px">
        <div class="row">
          <input type="text" id="fQ" placeholder="상품명/모델/발주번호 검색" value="${escapeHtml(f.q)}" style="min-width:280px;flex:1" />
          <select id="fReason"><option value="">사유 전체</option>${reasons.map(r=>`<option value="${escapeHtml(r)}" ${r===f.reason?"selected":""}>${escapeHtml(r)}</option>`).join("")}</select>
          <input type="date" id="fFrom" value="${f.from}" />
          <span class="muted">~</span>
          <input type="date" id="fTo" value="${f.to}" />
          <button class="btn" id="fReset">필터 초기화</button>
          <span class="spacer" style="flex:1"></span>
          <button class="btn primary" id="fExport">⤓ CSV</button>
          <button class="btn" id="fExportXlsx">⤓ XLSX</button>
        </div>
      </div>

      <div class="panel">
        <table class="t" id="detailTbl">
          <thead><tr>
            <th data-k="발주일자">발주일자</th>
            <th data-k="발주번호">발주번호</th>
            <th data-k="모델명">모델명</th>
            <th data-k="상품명">상품명</th>
            <th class="num" data-k="발주수량">발주</th>
            <th class="num" data-k="실제출고량">출고</th>
            <th class="num" data-k="미출고수량">미출고</th>
            <th class="num" data-k="미출고 금액">금액</th>
            <th data-k="미출고사유">사유</th>
            <th>비고</th>
          </tr></thead>
          <tbody id="detailBody"></tbody>
        </table>
        <div class="pager" id="detailPager"></div>
      </div>
    `;
  }
  function detailFiltered(){
    const f = State.detailFilter;
    const q = f.q.trim().toLowerCase();
    let from = f.from ? new Date(f.from) : null;
    let to = f.to ? new Date(f.to+"T23:59:59") : null;
    let res = State.rows.filter(r=>{
      if(State.period!=="all"){
        if(!r.발주일자) return false;
        if(ymKey(new Date(r.발주일자))!==State.period) return false;
      }
      if(f.reason && (r.미출고사유||"미분류")!==f.reason) return false;
      if(from && r.발주일자 && new Date(r.발주일자) < from) return false;
      if(to && r.발주일자 && new Date(r.발주일자) > to) return false;
      if(q){
        const blob = (r.발주번호+" "+r.상품명+" "+r.모델명+" "+(r.비고||"")).toLowerCase();
        if(!blob.includes(q)) return false;
      }
      return true;
    });
    const k = f.sort, dir = f.dir==="asc"?1:-1;
    res.sort((a,b)=>{
      let av=a[k], bv=b[k];
      if(k==="발주일자"){av=av?+new Date(av):0; bv=bv?+new Date(bv):0;}
      if(typeof av==="string") av=av.toLowerCase();
      if(typeof bv==="string") bv=bv.toLowerCase();
      return av>bv?dir:av<bv?-dir:0;
    });
    return res;
  }
  function afterDetail(){
    const renderBody = ()=>{
      const f = State.detailFilter;
      const all = detailFiltered();
      const total = all.length;
      const pages = Math.max(1, Math.ceil(total/f.pageSize));
      if(f.page>pages) f.page = pages;
      const slice = all.slice((f.page-1)*f.pageSize, f.page*f.pageSize);
      $("#detailBody").innerHTML = slice.map(r=>`
        <tr>
          <td>${r.발주일자 ? ymdKey(new Date(r.발주일자)) : "-"}</td>
          <td><code>${escapeHtml(r.발주번호)}</code></td>
          <td><b>${escapeHtml(r.모델명)}</b></td>
          <td><span class="truncate" title="${escapeHtml(r.상품명)}">${escapeHtml(r.상품명)}</span></td>
          <td class="num">${fmtN(r.발주수량)}</td>
          <td class="num">${fmtN(r.실제출고량)}</td>
          <td class="num"><b>${fmtN(r.미출고수량)}</b></td>
          <td class="num">${fmtW(r["미출고 금액"])}</td>
          <td><span class="pill ${reasonClass(r.미출고사유||"미분류")}">${escapeHtml(r.미출고사유||"미분류")}</span></td>
          <td><span class="muted truncate" style="max-width:200px" title="${escapeHtml(r.비고||"")}">${escapeHtml(r.비고||"")}</span></td>
        </tr>
      `).join("") || `<tr><td colspan="10" class="muted" style="padding:30px;text-align:center">조건에 맞는 데이터 없음</td></tr>`;
      // Pager
      $("#detailPager").innerHTML = `
        <span class="info">총 ${fmtN(total)}건 · ${f.page}/${pages}페이지</span>
        <button ${f.page<=1?"disabled":""} data-act="first">«</button>
        <button ${f.page<=1?"disabled":""} data-act="prev">‹</button>
        <button ${f.page>=pages?"disabled":""} data-act="next">›</button>
        <button ${f.page>=pages?"disabled":""} data-act="last">»</button>
      `;
      // Sort indicators
      $$("#detailTbl thead th").forEach(th=>{
        th.classList.remove("sort-asc","sort-desc");
        if(th.dataset.k===f.sort) th.classList.add(f.dir==="asc"?"sort-asc":"sort-desc");
      });
    };
    renderBody();

    $("#fQ").addEventListener("input", debounce(e=>{State.detailFilter.q=e.target.value;State.detailFilter.page=1;renderBody()},200));
    $("#fReason").addEventListener("change", e=>{State.detailFilter.reason=e.target.value;State.detailFilter.page=1;renderBody()});
    $("#fFrom").addEventListener("change", e=>{State.detailFilter.from=e.target.value;State.detailFilter.page=1;renderBody()});
    $("#fTo").addEventListener("change", e=>{State.detailFilter.to=e.target.value;State.detailFilter.page=1;renderBody()});
    $("#fReset").addEventListener("click", ()=>{State.detailFilter={q:"",reason:"",from:"",to:"",sort:"발주일자",dir:"desc",page:1,pageSize:50};render()});
    $$("#detailTbl thead th").forEach(th=>{
      if(!th.dataset.k) return;
      th.addEventListener("click", ()=>{
        const k = th.dataset.k;
        if(State.detailFilter.sort===k) State.detailFilter.dir = State.detailFilter.dir==="asc"?"desc":"asc";
        else { State.detailFilter.sort=k; State.detailFilter.dir = (k==="발주일자"||k==="미출고 금액"||k==="미출고수량")?"desc":"asc"; }
        renderBody();
      });
    });
    $("#detailPager").addEventListener("click", e=>{
      const a = e.target.dataset.act; if(!a) return;
      const all = detailFiltered();
      const pages = Math.max(1, Math.ceil(all.length/State.detailFilter.pageSize));
      const f = State.detailFilter;
      if(a==="first") f.page=1; if(a==="prev") f.page=Math.max(1,f.page-1);
      if(a==="next") f.page=Math.min(pages,f.page+1); if(a==="last") f.page=pages;
      renderBody();
    });
    $("#fExport").addEventListener("click", ()=>exportCSV(detailFiltered()));
    $("#fExportXlsx").addEventListener("click", ()=>exportXLSX(detailFiltered()));
  }
  function exportCSV(rows){
    const head = COLS;
    const csv = [head.join(",")].concat(rows.map(r=>head.map(h=>{
      let v = r[h];
      if(h==="발주일자" && v) v = ymdKey(new Date(v));
      v = v==null?"":String(v).replace(/"/g,'""');
      return /[,"\n]/.test(v) ? `"${v}"` : v;
    }).join(","))).join("\n");
    const blob = new Blob([new Uint8Array([0xEF,0xBB,0xBF]),csv], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href=url; a.download=`미출고_${new Date().toISOString().slice(0,10)}.csv`; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function exportXLSX(rows){
    const data = rows.map(r=>({
      발주일자: r.발주일자 ? ymdKey(new Date(r.발주일자)) : "",
      발주번호: r.발주번호, 상품명: r.상품명, 모델명: r.모델명,
      발주수량: r.발주수량, 실제출고량: r.실제출고량,
      미출고수량: r.미출고수량, "미출고 금액": r["미출고 금액"],
      미출고사유: r.미출고사유, 비고: r.비고
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "미출고");
    XLSX.writeFile(wb, `미출고_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  /* ===== 데이터 관리 ===== */
  function renderManage(){
    const noDate = State.rows.filter(r=>!r.발주일자).length;
    const fromFile = State.rows.filter(r=>r._dateFromFile).length;
    const noReason = State.rows.filter(r=>!r.미출고사유).length;
    const noAmt = State.rows.filter(r=>!r["미출고 금액"]).length;
    const sample = State.rows.find(r=>!r.발주일자);
    return `
      <div class="grid cols-2" style="margin-bottom:14px">
        <div class="panel">
          <h3>엑셀 업로드</h3>
          <div id="dropZone" class="drop">
            <div style="font-size:36px;line-height:1">📥</div>
            <div style="margin-top:8px"><b>엑셀 파일을 여기에 드롭</b>하거나 <span style="color:var(--brand);cursor:pointer" onclick="document.getElementById('fileInput').click()">파일 선택</span></div>
            <div class="sm" style="margin-top:8px">.xlsx · 여러 파일 가능 · 동일 발주번호+상품 자동 중복 제거</div>
          </div>
          <div class="hr"></div>
          <div class="muted sm">월 시트가 분리되어 있어도 발주일자 컬럼을 기준으로 자동 분류됩니다. 헤더는 1~5행 안에 있어야 인식되며, 다음 컬럼명을 자동 매칭합니다:</div>
          <div class="muted sm" style="margin-top:6px">
            발주일자 / 발주번호 / 상품명 / 모델명 / 발주수량 / 실제출고량 / 미출고수량 / 미출고 금액 / 미출고사유 / 비고
          </div>
        </div>

        <div class="panel">
          <h3>현재 보관 중인 데이터</h3>
          <div class="row" style="margin-bottom:10px">
            <div class="kpi"><div class="lbl">총 행 수</div><div class="val" style="font-size:22px">${fmtN(State.rows.length)}</div></div>
            <div class="kpi"><div class="lbl">월</div><div class="val" style="font-size:22px">${getPeriods().length}</div></div>
            <div class="kpi"><div class="lbl">파일</div><div class="val" style="font-size:22px">${State.files.length}</div></div>
            <span class="spacer" style="flex:1"></span>
            <button class="btn" id="btnExportAll">⤓ 전체 XLSX</button>
            <button class="btn danger" id="btnReset">전체 초기화</button>
          </div>
          <table class="t">
            <thead><tr><th>파일명</th><th class="num">행수</th><th class="num">크기</th><th>업로드 시각</th></tr></thead>
            <tbody>
              ${State.files.length ? State.files.map((f,i)=>`
                <tr>
                  <td>${escapeHtml(f.name)}</td>
                  <td class="num">${fmtN(f.rowCount)}</td>
                  <td class="num">${(f.size/1024).toFixed(1)} KB</td>
                  <td>${new Date(f.addedAt).toLocaleString("ko-KR")}</td>
                </tr>
              `).join("") : `<tr><td colspan="4" class="muted">업로드 이력 없음</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      ${noDate||noAmt||fromFile ? `
      <div class="panel" style="margin-bottom:14px;border-color:${noDate?'rgba(248,81,73,.5)':'rgba(210,153,34,.5)'}">
        <h3 style="color:${noDate?'#ff8e87':'#f1c84e'}">${noDate?'⚠ 매핑 진단':'ℹ 매핑 보정'}</h3>
        <table class="t">
          <tr><td>발주일자가 매핑 안 된 행</td><td class="num"><b style="color:${noDate?'#ff8e87':'inherit'}">${fmtN(noDate)}</b> / ${fmtN(State.rows.length)} 건</td></tr>
          <tr><td>파일 날짜로 자동 보정된 행</td><td class="num"><b style="color:#f1c84e">${fmtN(fromFile)}</b> 건</td></tr>
          <tr><td>미출고사유가 비어있는 행</td><td class="num">${fmtN(noReason)} 건</td></tr>
          <tr><td>미출고 금액이 0인 행</td><td class="num">${fmtN(noAmt)} 건</td></tr>
        </table>
        ${sample ? `
          <div class="hr"></div>
          <div class="muted sm">매핑 실패 첫 행 샘플 (어떤 양식인지 확인용):</div>
          <pre style="background:#0e1117;padding:10px;border-radius:8px;font-size:11px;overflow:auto;color:#9aa4b2;margin-top:6px;max-height:200px">${escapeHtml(JSON.stringify(sample,null,2))}</pre>
        ` : ""}
      </div>` : ""}

      <div class="panel">
        <h3>월별 데이터 요약</h3>
        <table class="t">
          <thead><tr><th>월</th><th class="num">건수</th><th class="num">수량</th><th class="num">금액</th></tr></thead>
          <tbody>
            ${aggMonthly(State.rows).map(m=>`
              <tr>
                <td><b>${m.period}</b></td>
                <td class="num">${fmtN(m.count)}</td>
                <td class="num">${fmtN(m.qty)}</td>
                <td class="num">${fmtW(m.amt)}</td>
            `).join("") || `<tr><td colspan="4" class="muted">데이터 없음</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
  }
  function afterManage(){
    bindEmpty();
    $("#btnReset")?.addEventListener("click", ()=>{
      if(confirm("모든 업로드 데이터를 삭제할까요? 이 작업은 되돌릴 수 없습니다.")){
        State.rows = []; State.files = []; save(); render();
        toast("초기화 완료","ok");
      }
    });
    $("#btnExportAll")?.addEventListener("click", ()=>exportXLSX(State.rows));
  }

  /* ---------- 이벤트 바인딩 ---------- */
  function bind(){
    $$(".tab").forEach(t=>t.addEventListener("click", ()=>{
      $$(".tab").forEach(x=>x.classList.remove("active"));
      t.classList.add("active");
      State.activeTab = t.dataset.tab;
      render();
    }));
    $("#periodSelect").addEventListener("change", e=>{ State.period = e.target.value; render(); });
    $("#fileInput").addEventListener("change", e=>{
      const fs = [...e.target.files]; if(fs.length) ingestFiles(fs);
      e.target.value = "";
    });
    window.addEventListener("dragover", e=>{e.preventDefault()});
    window.addEventListener("drop", e=>{
      if(!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      ingestFiles([...e.dataTransfer.files]);
    });
  }

  /* ---------- 초기화 ---------- */
  load();
  bind();
  render();
})();
