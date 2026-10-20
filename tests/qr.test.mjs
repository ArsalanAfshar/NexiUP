import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { qrPng, mainSubscriptionUrl } from '../worker.js';

// Small independent, test-only reader for pristine Model 2 / M / byte-mode / mask-0
// fixtures. Uses PNG pixels, not the encoder's matrix or a hidden metadata payload.
// Tables are QR specification values; no encoder/library imports are used to decode.
export function pngPixels(png) {
  assert.deepEqual([...png.slice(0,8)],[137,80,78,71,13,10,26,10]);
  const view=new DataView(png.buffer,png.byteOffset,png.byteLength);let p=8,width,height,depth,type;const data=[];
  while(p<png.length){const n=view.getUint32(p),tag=new TextDecoder().decode(png.slice(p+4,p+8)),body=png.slice(p+8,p+8+n);p+=12+n;
    if(tag==='IHDR'){const v=new DataView(body.buffer,body.byteOffset);width=v.getUint32(0);height=v.getUint32(4);depth=body[8];type=body[9];}
    if(tag==='IDAT')data.push(body);
  }
  assert.equal(depth,1);assert.equal(type,0);assert.equal(width,height);
  const raw=inflateSync(Buffer.concat(data)),stride=Math.ceil(width/8),rgba=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++){assert.equal(raw[y*(stride+1)],0);for(let x=0;x<width;x++){const v=(raw[y*(stride+1)+1+(x>>3)]>>(7-(x%8)))&1,o=(y*width+x)*4;rgba[o]=rgba[o+1]=rgba[o+2]=v*255;rgba[o+3]=255;}}
  return {width,height,rgba};
}
export function decodeFixturePng(png) {
  const {width,rgba}=pngPixels(png),scale=5,n=width/scale-8,ver=(n-17)/4;
  assert.ok(Number.isInteger(ver)&&ver>=1&&ver<=10);
  const at=(x,y)=>rgba[((y+4)*scale*width+(x+4)*scale)*4]===0;
  const reserved=Array.from({length:n},()=>Array(n).fill(false));
  const mark=(x,y)=>{if(x>=0&&y>=0&&x<n&&y<n)reserved[y][x]=true;};
  for(let i=0;i<n;i++){mark(6,i);mark(i,6);}
  for(const [cx,cy] of [[3,3],[n-4,3],[3,n-4]])for(let y=-4;y<=4;y++)for(let x=-4;x<=4;x++)mark(cx+x,cy+y);
  const align=[[],[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]][ver];
  for(const y of align)for(const x of align){if((x===6&&(y===6||y===n-7))||(x===n-7&&y===6))continue;for(let j=-2;j<=2;j++)for(let i=-2;i<=2;i++)mark(x+i,y+j);}
  for(let i=0;i<6;i++)mark(8,i);mark(8,7);mark(8,8);mark(7,8);for(let i=9;i<15;i++)mark(14-i,8);
  for(let i=0;i<8;i++)mark(n-1-i,8);for(let i=8;i<15;i++)mark(8,n-15+i);mark(8,n-8);
  if(ver>=7)for(let y=0;y<6;y++)for(let x=0;x<3;x++){mark(n-11+x,y);mark(y,n-11+x);}
  const bits=[];let up=true;
  for(let right=n-1;right>=1;right-=2){if(right===6)right--;for(let k=0;k<n;k++){const y=up?n-1-k:k;for(let side=0;side<2;side++){const x=right-side;if(!reserved[y][x])bits.push(Number(at(x,y))^Number((x+y)%2===0));}}up=!up;}
  const raw=[];for(let i=0;i+7<bits.length;i+=8)raw.push(bits.slice(i,i+8).reduce((v,b)=>(v<<1)|b,0));
  const total=[0,26,44,70,100,134,172,196,242,292,346][ver],blocks=[0,1,1,1,2,2,4,4,4,5,5][ver],ecc=[0,10,16,26,18,24,16,18,22,22,26][ver];
  const short=Math.floor(total/blocks)-ecc,longCount=total%blocks,words=Array.from({length:blocks},()=>[]);let cursor=0;
  for(let j=0;j<short+1;j++)for(let block=0;block<blocks;block++){const len=short+(block>=blocks-longCount?1:0);if(j<len)words[block].push(raw[cursor++]);}
  const data=words.flat(),dbits=data.flatMap(v=>Array.from({length:8},(_,k)=>(v>>(7-k))&1));let off=0;
  const read=n=>{let v=0;for(let i=0;i<n;i++)v=(v<<1)|dbits[off++];return v;};
  assert.equal(read(4),4);const count=read(ver>=10?16:8);const payload=Uint8Array.from({length:count},()=>read(8));return new TextDecoder().decode(payload);
}

test('independent PNG-pixel QR decoder recovers exact main subscription URL',()=>{
  for(const host of ['https://main.example.test','https://'+('long'.repeat(10))+'.example.test']){
    const url=mainSubscriptionUrl({main_url:host},crypto.randomUUID().replaceAll('-',''));
    const png=qrPng(url);assert.equal(decodeFixturePng(png),url);
    // No tEXt/iTXt payload to fake a round-trip: actual QR modules carry the URL.
    assert.equal(new TextDecoder().decode(png).includes(url),false);
  }
});
test('PNG QR carries UTF-8 correctly and has the required quiet zone',()=>{
  const text='https://main.example.test/?label='+encodeURIComponent('همراه اول');
  const png=qrPng(text);assert.equal(decodeFixturePng(png),text);const {rgba,width}=pngPixels(png);
  for(let y=0;y<20;y++)for(let x=0;x<width;x++)assert.equal(rgba[(y*width+x)*4],255);
});
