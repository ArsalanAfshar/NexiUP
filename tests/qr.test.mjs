import test from 'node:test';
import assert from 'node:assert/strict';
import { qrPng, mainSubscriptionUrl } from '../worker.js';

import { pngPixels, decodeFixturePng } from './qr-helpers.mjs';
export { pngPixels, decodeFixturePng } from './qr-helpers.mjs';

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
