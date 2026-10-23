// Development-only assembly. Both committed outputs are complete paste-ready
// ES modules; users do not need Node/npm/build tooling to deploy either file.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const legacy=await read('worker.js');
const tree=ts.createSourceFile('worker.js',legacy,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const definitions=new Map();
for(const item of tree.statements){
  if(ts.isFunctionDeclaration(item)&&item.name)definitions.set(item.name.text,item.getText(tree));
  if(ts.isVariableStatement(item))for(const declaration of item.declarationList.declarations)if(ts.isIdentifier(declaration.name))definitions.set(declaration.name.text,item.getText(tree));
}
const extract=names=>names.map(name=>{if(!definitions.has(name))throw new Error('Missing owned helper '+name);return definitions.get(name);}).join('\n\n');
const shared=await read('mesh/common.js')+'\n'+extract(['concat']);
const managerHelpers=extract(['sha224','DEFAULT_PROFILES','rangeString','validateProfile','base64Utf8','parseBaseUri','aggregate','baseUri','variantUri','xrayConfig','renderSubscription','crc32','u32','pngChunk','qrMatrix','qrPng']).replace('string(text, 300, 1)','string(text, 340, 1)');
const nodeHelpers=extract(['addressAt','parseTunnelHeader']);
const marker='// ---- Embedded QR encoder follows.';
if(!legacy.includes(marker))throw new Error('QR license boundary missing');
const qr=legacy.slice(legacy.indexOf(marker)).replace(/[ \t]+$/gm,''); // normalize generated-code trailing whitespace only
const font=legacy.match(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/)?.[1];if(!font)throw new Error('Font not found');
const notice=await read('docs/licenses/Vazirmatn-OFL.txt');
const fontCss='/* '+notice.replaceAll('*/','* /')+' */\n@font-face{font-family:Vazirmatn;font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,'+font+') format(\'woff2\');}\n';
const header=component=>`/*!\n * NexiUP Mesh 3.0.0 — ${component}.\n * Copyright (c) 2026 NexiUP Contributors. MIT; see LICENSE.\n * Standalone ES module: paste this COMPLETE file. No runtime npm dependency.\n * Generated from original mesh/ sources by scripts/build-mesh.mjs.\n * No Nahan or uploaded third-party tunnel/UI source is copied here.\n${component==='manager'?' * Embedded QR: Nayuki MIT. Embedded unmodified font: Vazirmatn OFL-1.1.\n':''} */\n\n`;
const manager=header('manager')+shared+'\n\n'+managerHelpers+'\n\n'+await read('mesh/database.js')+'\n'+await read('mesh/control.js')+'\n'+await read('mesh/admin.js')+'\nconst FONT_CSS = '+JSON.stringify(fontCss)+';\n'+await read('mesh/console.js')+'\n'+await read('mesh/manager.js')+'\n'+qr;
const node=header('node')+shared+'\n\n'+nodeHelpers+'\n\n'+await read('mesh/node.js');
for(const [file,content]of [['manager-worker.js',manager],['node-worker.js',node]]){
  if(process.argv.includes('--check')){if(await read(file)!==content)throw new Error(file+' is stale; run npm run build:mesh');}
  else await writeFile(new URL(file,root),content);
  console.log(file+': '+Buffer.byteLength(content)+' bytes'+(process.argv.includes('--check')?' (reproducible)':''));
}
