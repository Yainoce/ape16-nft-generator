(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const state = {
    zip: null,
    categories: [],
    files: new Map(),
    plan: [],
    imageW: null,
    imageH: null
  };

  function setStatus(text, cls="idle"){
    const el=$("status"); el.textContent=text; el.className="pill "+cls;
  }
  function basename(path){ return path.split("/").pop(); }
  function stripExt(name){ return name.replace(/\.[^.]+$/,""); }
  function categoryOf(path){
    const parts=path.split("/").filter(Boolean);
    return parts.length >= 2 ? parts[parts.length-2] : null;
  }
  function downloadBlob(blob, name){
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob); a.download=name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  }

  // xmur3 + mulberry32: small deterministic PRNG suitable for collection planning.
  function xmur3(str){
    let h=1779033703 ^ str.length;
    for(let i=0;i<str.length;i++){ h=Math.imul(h ^ str.charCodeAt(i),3432918353); h=h<<13|h>>>19; }
    return function(){ h=Math.imul(h ^ (h>>>16),2246822507); h=Math.imul(h ^ (h>>>13),3266489909); return (h^=h>>>16)>>>0; }
  }
  function mulberry32(a){
    return function(){ let t=a+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61); return ((t^t>>>14)>>>0)/4294967296; }
  }
  function weightedPick(items, rng){
    const total=items.reduce((s,x)=>s+Math.max(0,Number(x.weight)||0),0);
    if(total<=0) throw new Error("A category has no positive trait weights.");
    let r=rng()*total;
    for(const item of items){ r-=Math.max(0,Number(item.weight)||0); if(r<=0)return item; }
    return items[items.length-1];
  }
  function parseRules(){
    return $("rules").value.split(/\n+/).map(s=>s.trim()).filter(Boolean).map((line,idx)=>{
      const p=line.split("!");
      if(p.length!==2) throw new Error(`Rule ${idx+1} is invalid.`);
      const parseSide=s=>{
        const q=s.trim().split("=");
        if(q.length!==2) throw new Error(`Rule ${idx+1} is invalid.`);
        return {category:q[0].trim(), trait:q[1].trim()};
      };
      return [parseSide(p[0]),parseSide(p[1])];
    });
  }
  function violates(combo,rules){
  for(const [a,b] of rules){
    if(
      combo[a.category] === a.trait &&
      combo[b.category] === b.trait
    ){
      return true;
    }
  }
  return false;
}
  function signature(combo,categories){
    return categories.map(c=>`${c.name}:${combo[c.name]}`).join("|");
  }
  function currentCategories(){
    return [...document.querySelectorAll(".layer")].map(layer=>{
      const name=layer.dataset.category;
      const traits=[...layer.querySelectorAll(".trait-row")].map(row=>({
        name:row.dataset.trait,
        path:row.dataset.path,
        weight:Number(row.querySelector('input[data-role="weight"]').value),
        exact:Number(row.querySelector('input[data-role="exact"]').value) || 0
      }));
      return {name, traits};
    });
  }

  async function loadImageDimensions(file){
    const blob=await file.async("blob");
    const bmp=await createImageBitmap(blob);
    const dims=[bmp.width,bmp.height];
    bmp.close();
    return dims;
  }
function updateBuildButton(){
  const supply = Number($("supply").value) || 0;
  $("buildBtn").textContent =
    `Generate ${supply.toLocaleString()}-token plan`;
}

$("supply").addEventListener("input", updateBuildButton);
updateBuildButton();
  $("zipInput").addEventListener("change", async e=>{
    const f=e.target.files[0]; if(!f)return;
    try{
      setStatus("LOADING","busy");
      if(typeof JSZip==="undefined") throw new Error("ZIP library did not load. Internet access is required when opening this version.");
      const zip=await JSZip.loadAsync(f);
      const pngs=Object.values(zip.files).filter(x=>!x.dir && /\.png$/i.test(x.name) && !x.name.startsWith("__MACOSX/"));
      if(!pngs.length) throw new Error("No PNG files found in the ZIP.");
      const cats=new Map();
      for(const file of pngs){
        const cat=categoryOf(file.name);
        if(!cat) continue;
        if(!cats.has(cat))cats.set(cat,[]);
        cats.get(cat).push({name:stripExt(basename(file.name)),path:file.name,weight:1});
        state.files.set(file.name,file);
      }
      if(!cats.size) throw new Error("PNG files must be inside category folders.");
      // Validate canvas dimensions against first PNG and then all PNGs.
      const first=pngs[0];
      const [w,h]=await loadImageDimensions(first);
      state.imageW=w; state.imageH=h;
      for(let i=1;i<pngs.length;i++){
        const [cw,ch]=await loadImageDimensions(pngs[i]);
        if(cw!==w || ch!==h) throw new Error(`Canvas mismatch: ${pngs[i].name} is ${cw}×${ch}, expected ${w}×${h}.`);
      }
      state.zip=zip;

const preferredOrder = [
  "Background",
  "Body",
  "Clothes",
  "Eyes",
  "Mouth",
  "Headwear",
  "Accessories"
];

state.categories=[...cats].map(([name,traits])=>({name,traits}));
state.categories.sort((a,b)=>{
  const ai=preferredOrder.indexOf(a.name);
  const bi=preferredOrder.indexOf(b.name);
  const aOrder=ai === -1 ? preferredOrder.length : ai;
  const bOrder=bi === -1 ? preferredOrder.length : bi;
  return aOrder-bOrder || a.name.localeCompare(b.name);
});

renderLayers();
      $("traitSummary").textContent=`Loaded ${pngs.length} PNG traits across ${state.categories.length} categories.\nCanvas: ${w}×${h}px\nAll PNG canvases match.`;
      $("buildBtn").disabled=false;
      state.plan=[];
      disablePostBuild();
      setStatus("READY","ok");
    }catch(err){
      console.error(err); setStatus("ERROR","error"); $("traitSummary").textContent=err.message;
    }
  });

  function renderLayers(){
    const host=$("layers"); host.innerHTML="";
    for(const cat of state.categories){
      const box=document.createElement("div"); box.className="layer"; box.dataset.category=cat.name;
      const head=document.createElement("div"); head.className="layer-head";
      head.innerHTML=`<strong>${cat.name}</strong><small>${cat.traits.length} traits</small>`;
      box.appendChild(head);
      for(const trait of cat.traits){
        const row=document.createElement("div"); row.className="trait-row";
        row.dataset.trait=trait.name; row.dataset.path=trait.path;
        const name=document.createElement("div"); name.className="trait-name"; name.textContent=trait.name;
        const weight=document.createElement("input");
weight.type="number";
weight.min="0";
weight.step="0.1";
weight.value="1";
weight.title="Weight";
weight.dataset.role="weight";

const exact=document.createElement("input");
exact.type="number";
exact.min="0";
exact.step="1";
exact.value="0";
exact.title="Exact Count";
exact.placeholder="Exact";
exact.dataset.role="exact";

row.append(name,weight,exact);
box.appendChild(row);
      }
      host.appendChild(box);
    }
  }
  function disablePostBuild(){
    $("exportPlanBtn").disabled=true; $("renderBtn").disabled=true; $("auditBtn").disabled=true;
    $("buildInfo").textContent="Load traits, set weights/rules, then generate the collection plan.";
    $("renderInfo").textContent="Build the collection plan first.";
    $("auditPreview").textContent="No audit yet.";
  }

  $("buildBtn").addEventListener("click", async ()=>{
    try{
      setStatus("BUILDING","busy");
      const supply=Number($("supply").value);
      if(!Number.isInteger(supply)||supply<1) throw new Error("Supply must be a positive integer.");
      const categories=currentCategories();
      const rules=parseRules();
      const seedText=$("seed").value || "NFT";
      const seed=xmur3(seedText)();
      const rng=mulberry32(seed);
      const used=new Set(), plan=[];
      let attempts=0;
      const maxAttempts=Math.max(100000,supply*5000);

      while(plan.length<supply && attempts<maxAttempts){
        attempts++;
        const combo={};
        for(const cat of categories) combo[cat.name]=weightedPick(cat.traits,rng).name;
        if(violates(combo,rules))continue;
        const sig=signature(combo,categories);
        if(used.has(sig))continue;
        used.add(sig);
        plan.push({tokenId:plan.length+1,traits:combo});
      }
      if(plan.length<supply){
        throw new Error(`Could only create ${plan.length} unique valid combinations. Add more traits, loosen exclusions, or lower supply.`);
      }
      state.plan=plan;
      state.categories=categories;
      $("startToken").max=supply; $("renderCount").value=Math.min(Number($("batchSize").value)||150,supply);
      $("exportPlanBtn").disabled=false; $("renderBtn").disabled=false; $("auditBtn").disabled=false;
      $("buildInfo").textContent=`SUCCESS\n${plan.length.toLocaleString()} unique tokens planned.\n${attempts.toLocaleString()} random rolls used.\nSeed: ${seedText}\nNo duplicate trait combinations.`;
      showAudit();
      setStatus("PLAN READY","ok");
    }catch(err){
      console.error(err); setStatus("ERROR","error"); $("buildInfo").textContent=err.message;
    }
  });

  function metadataFor(item){
    const collection=$("collectionName").value || "Collection";
    return {
      name:`${collection} #${item.tokenId}`,
      description:`${collection} collection`,
      image:`ipfs://REPLACE_IMAGE_CID/${item.tokenId}.png`,
      attributes:state.categories.map(c=>({trait_type:c.name,value:item.traits[c.name]}))
    };
  }

  $("exportPlanBtn").addEventListener("click", async ()=>{
    try{
      setStatus("EXPORTING","busy");
      const z=new JSZip();
      z.file("manifest.json",JSON.stringify({
        collection:$("collectionName").value,
        supply:state.plan.length,
        seed:$("seed").value,
        canvas:{width:state.imageW,height:state.imageH},
        tokens:state.plan
      },null,2));
      const md=z.folder("metadata");
      for(const item of state.plan) md.file(`${item.tokenId}.json`,JSON.stringify(metadataFor(item),null,2));
      const blob=await z.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:6}});
      downloadBlob(blob,`${safeName($("collectionName").value)}_manifest_metadata.zip`);
      setStatus("PLAN READY","ok");
    }catch(err){ setStatus("ERROR","error"); alert(err.message); }
  });

  function safeName(s){ return (s||"collection").replace(/[^a-z0-9_-]+/gi,"_"); }

  async function bitmapFor(path){
    const file=state.files.get(path);
    if(!file)throw new Error(`Missing trait image: ${path}`);
    const blob=await file.async("blob");
    return await createImageBitmap(blob);
  }
  function traitPath(category,trait){
    const cat=state.categories.find(c=>c.name===category);
    const t=cat?.traits.find(x=>x.name===trait);
    return t?.path;
  }

  $("renderBtn").addEventListener("click", async ()=>{
    try{
      const start=Number($("startToken").value);
      const count=Number($("renderCount").value);
      if(!Number.isInteger(start)||!Number.isInteger(count)||start<1||count<1)throw new Error("Invalid batch range.");
      const end=Math.min(state.plan.length,start+count-1);
      if(start>state.plan.length)throw new Error("Start token is beyond the collection supply.");
      setStatus("RENDERING","busy"); $("renderBtn").disabled=true;
      const zip=new JSZip(), images=zip.folder("images");
      const canvas=document.createElement("canvas"); canvas.width=state.imageW; canvas.height=state.imageH;
      const ctx=canvas.getContext("2d",{alpha:true});
      ctx.imageSmoothingEnabled=false;
      const total=end-start+1;
      for(let token=start; token<=end; token++){
        const item=state.plan[token-1];
        ctx.clearRect(0,0,canvas.width,canvas.height);
        for(const cat of state.categories){
          const p=traitPath(cat.name,item.traits[cat.name]);
          const bmp=await bitmapFor(p);
          ctx.drawImage(bmp,0,0); bmp.close();
        }
        const blob=await new Promise(res=>canvas.toBlob(res,"image/png"));
        images.file(`${item.tokenId}.png`,blob);
        const done=token-start+1; $("progress").value=done/total;
        $("renderInfo").textContent=`Rendering ${start}–${end}\n${done}/${total}`;
        // Give mobile Safari opportunities to paint / reclaim.
        if(done%10===0) await new Promise(r=>setTimeout(r,0));
      }
      const out=await zip.generateAsync({type:"blob",compression:"STORE"});
      downloadBlob(out,`${safeName($("collectionName").value)}_images_${start}-${end}.zip`);
      $("renderInfo").textContent=`DONE\nExported token images ${start}–${end}.\nNext start token: ${end+1<=state.plan.length?end+1:"collection complete"}`;
      if(end<state.plan.length)$("startToken").value=end+1;
      setStatus("PLAN READY","ok");
    }catch(err){
      console.error(err); setStatus("ERROR","error"); $("renderInfo").textContent=err.message;
    }finally{$("renderBtn").disabled=state.plan.length===0;}
  });

  function auditRows(){
    const counts={};
    for(const c of state.categories){counts[c.name]={}; for(const t of c.traits)counts[c.name][t.name]=0;}
    for(const item of state.plan) for(const c of state.categories) counts[c.name][item.traits[c.name]]++;
    const rows=[];
    for(const c of state.categories) for(const t of c.traits){
      const n=counts[c.name][t.name]||0;
      rows.push({category:c.name,trait:t.name,count:n,percent:(100*n/state.plan.length)});
    }
    return rows;
  }
  function showAudit(){
    const rows=auditRows();
    const rare=[...rows].sort((a,b)=>a.percent-b.percent).slice(0,8);
    $("auditPreview").textContent="Rarest generated traits:\n"+rare.map(r=>`${r.category} / ${r.trait}: ${r.count} (${r.percent.toFixed(2)}%)`).join("\n");
  }
  $("auditBtn").addEventListener("click",()=>{
    const rows=auditRows();
    const csv=["Category,Trait,Count,Percent",...rows.map(r=>[r.category,r.trait,r.count,r.percent.toFixed(4)].map(v=>`"${String(v).replaceAll('"','""')}"`).join(","))].join("\n");
    downloadBlob(new Blob([csv],{type:"text/csv"}),`${safeName($("collectionName").value)}_rarity_audit.csv`);
  });

  window.addEventListener("error",e=>{ console.error(e.error||e.message); });
})();
