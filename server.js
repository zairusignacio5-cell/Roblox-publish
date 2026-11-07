const express = require("express");
const zlib = require("zlib");
const crypto = require("crypto");
const path = require("path");
const app = express();

/* ------------------------------------------------------------------ */
/*  Binary .rbxl reader / writer (only touches script Source strings)  */
/* ------------------------------------------------------------------ */

// LZ4 block decoder (older place files use LZ4, newer ones use zstd)
function lz4(src, usize) {
  const out = Buffer.alloc(usize);
  let i = 0, o = 0;
  while (i < src.length) {
    const t = src[i++];
    let ll = t >> 4;
    if (ll === 15) { let b; do { b = src[i++]; ll += b; } while (b === 255); }
    src.copy(out, o, i, i + ll); i += ll; o += ll;
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8); i += 2;
    let ml = t & 15;
    if (ml === 15) { let b; do { b = src[i++]; ml += b; } while (b === 255); }
    ml += 4;
    for (let k = 0; k < ml; k++, o++) out[o] = out[o - off];
  }
  return out;
