const fs = require('fs');
const path = require('path');

const pngPath = path.join(__dirname, 'build', 'icon.png');
const icoPath = path.join(__dirname, 'build', 'icon.ico');
const png = fs.readFileSync(pngPath);

// 检查是否为 256x256（ICONDIR 中宽高为 0 表示 256）
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);    // reserved
header.writeUInt16LE(1, 2);    // type: icon
header.writeUInt16LE(1, 4);    // image count

const entry = Buffer.alloc(16);
entry[0] = 0;                   // width  (0 => 256)
entry[1] = 0;                   // height (0 => 256)
entry[2] = 0;                   // color count
entry[3] = 0;                   // reserved
entry.writeUInt16LE(1, 4);      // planes
entry.writeUInt16LE(32, 6);     // bit count
entry.writeUInt32LE(png.length, 8);   // bytes in resource
entry.writeUInt32LE(22, 12);          // image offset

fs.writeFileSync(icoPath, Buffer.concat([header, entry, png]));
console.log('icon.ico created, size =', fs.statSync(icoPath).size, 'bytes');