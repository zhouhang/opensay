import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=fs.readFileSync(new URL('../platforms/wechat-channels.mjs',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function compareWechatReplacementCoverPixels('),source.indexOf('async function wechatReplacementEvidence('));

async function compare({wrong=false,black=false,tainted=false}={}){
  let draws=0;
  const pattern=variant=>{const out=new Uint8ClampedArray(48*48*4);for(let i=0;i<48*48;i++){const x=i%48,y=Math.floor(i/48),v=black?7:variant===1?(x*29+y*3)%256:(x*3+y*29)%256;out[i*4]=v;out[i*4+1]=(v*2)%256;out[i*4+2]=(v*3)%256;out[i*4+3]=255}return out};
  class Image{
    set src(value){const native=value.startsWith('https://');this.naturalWidth=native?720:1792;this.naturalHeight=native?540:1344;this.pattern=pattern(native&&wrong?1:0);queueMicrotask(()=>this.onload())}
  }
  const document={createElement(tag){assert.equal(tag,'canvas');const canvas={width:0,height:0,pattern:null,getContext(){return {
    imageSmoothingEnabled:false,imageSmoothingQuality:'low',
    drawImage(input,_x,_y,w,h){draws++;assert.equal(this.imageSmoothingEnabled,true);assert.equal(this.imageSmoothingQuality,'high');const iw=input.naturalWidth||input.width,ih=input.naturalHeight||input.height;assert.ok(iw/w<=2.001&&ih/h<=2.001,'text-heavy exported covers require a prefiltered sample at every reduction');canvas.pattern=input.pattern},
    getImageData(){if(tainted)throw new Error('SecurityError tainted native image');return {data:canvas.pattern}}
  }}};return canvas}};
  const context=vm.createContext({wechatReplacementCoverAssets:()=>[{slot:'horizontal',dataUrl:'source-data',sha256:'a'.repeat(64)}],
    js:async expression=>vm.runInNewContext(expression,{Image,document,setTimeout,clearTimeout})});
  vm.runInContext(code,context);
  const result=await vm.runInContext(`compareWechatReplacementCoverPixels({gates:{cover:{ok:true,evidence:{layout:'separate',urlsBySlot:{horizontal:['https://native.example/cover']}}}}})`,context);
  return {result,draws};
}

test('WeChat 1792px approved cover and 720px native export use antialiased staged sampling without loosening identity thresholds',async()=>{
  const {result,draws}=await compare();assert.equal(result.ok,true);assert.ok(draws>=8);assert.equal(result.slots[0].correlation,1);assert.equal(result.slots[0].rmse,0);
});

test('WeChat cover resampling still rejects another image, a uniform export and unreadable native pixels',async()=>{
  for(const options of [{wrong:true},{black:true},{tainted:true}])assert.equal((await compare(options)).result.ok,false);
});
