/*
 * 极简二维码生成器（byte 模式，纠错等级 M，版本 1–10）。
 *
 * 为什么自己写：电视端 / 手机端页面是离线内嵌的（assets 里），
 * 不能依赖 CDN，也不想为了出一张码去引第三方包。
 * 「扫一扫当遥控器」的链接长度固定在 40–60 字符，版本 1–10 完全够用。
 *
 * 用法：
 *   var m = MFlixQR.encode('http://192.168.2.247:8080/rc?t=ABCDEF'); // 返回 {size, modules}
 *   container.innerHTML = MFlixQR.svg(text, { px: 4 });              // 直接给 SVG 字符串
 */
(function (root) {
  'use strict';

  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) {
    if (!a || !b) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // 版本 → [总码字数, 每块纠错码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字]（纠错等级 M）
  var EC_M = {
    1: [26, 10, 1, 16, 0, 0],
    2: [44, 16, 1, 28, 0, 0],
    3: [70, 26, 1, 44, 0, 0],
    4: [100, 18, 2, 32, 0, 0],
    5: [134, 24, 2, 43, 0, 0],
    6: [172, 16, 4, 27, 0, 0],
    7: [196, 18, 4, 31, 0, 0],
    8: [242, 22, 2, 38, 2, 39],
    9: [292, 22, 3, 36, 2, 37],
    10: [346, 26, 4, 43, 1, 44],
  };

  // 对齐图案中心坐标
  var ALIGN = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
  };

  function dataCapacity(ver) {
    var e = EC_M[ver];
    return e[2] * e[3] + e[4] * e[5];
  }

  /** 纠错码字生成多项式 */
  function rsGenPoly(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenPoly(ecLen);
    var res = new Array(data.length + ecLen).fill(0);
    for (var i = 0; i < data.length; i++) res[i] = data[i];
    for (var i2 = 0; i2 < data.length; i2++) {
      var factor = res[i2];
      if (!factor) continue;
      for (var j = 0; j < gen.length; j++) res[i2 + j] ^= gmul(gen[j], factor);
    }
    return res.slice(data.length);
  }

  /** 文本 → 最终码字序列（含分块交织） */
  function buildCodewords(bytes, ver) {
    var cap = dataCapacity(ver);
    var bits = [];
    function put(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }
    put(0x4, 4); // byte 模式
    put(bytes.length, ver <= 9 ? 8 : 16);

    for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);

    // 终止符 + 补齐到字节
    var maxBits = cap * 8;
    for (var t = 0; t < 4 && bits.length < maxBits; t++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    var data = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      data.push(v);
    }
    var pad = [0xec, 0x11];
    var p = 0;
    while (data.length < cap) data.push(pad[p++ % 2]);

    // 分块
    var e = EC_M[ver];
    var ecLen = e[1];
    var blocks = [];
    var off = 0;
    for (var g1 = 0; g1 < e[2]; g1++) {
      blocks.push(data.slice(off, off + e[3]));
      off += e[3];
    }
    for (var g2 = 0; g2 < e[4]; g2++) {
      blocks.push(data.slice(off, off + e[5]));
      off += e[5];
    }

    var ecBlocks = blocks.map(function (blk) {
      return rsEncode(blk, ecLen);
    });

    var out = [];
    var maxData = Math.max.apply(
      null,
      blocks.map(function (b) {
        return b.length;
      })
    );
    for (var c = 0; c < maxData; c++) {
      for (var bi = 0; bi < blocks.length; bi++) {
        if (c < blocks[bi].length) out.push(blocks[bi][c]);
      }
    }
    for (var c2 = 0; c2 < ecLen; c2++) {
      for (var bj = 0; bj < ecBlocks.length; bj++) out.push(ecBlocks[bj][c2]);
    }
    return out;
  }

  function makeMatrix(ver) {
    var size = ver * 4 + 17;
    var m = [];
    var reserved = [];
    for (var r = 0; r < size; r++) {
      m.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(0));
    }

    function setFn(r, c, v) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      m[r][c] = v ? 1 : 0;
      reserved[r][c] = 1;
    }

    // 定位图案（三个角）
    function finder(r0, c0) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var r = r0 + dr;
          var c = c0 + dc;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          var inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          var dark = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          setFn(r, c, dark ? 1 : 0);
        }
      }
    }
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // 时序图案
    for (var i = 8; i < size - 8; i++) {
      setFn(6, i, i % 2 === 0 ? 1 : 0);
      setFn(i, 6, i % 2 === 0 ? 1 : 0);
    }

    // 对齐图案
    var al = ALIGN[ver] || [];
    for (var a = 0; a < al.length; a++) {
      for (var b = 0; b < al.length; b++) {
        var cr = al[a];
        var cc = al[b];
        if ((cr === 6 && cc === 6) || (cr === 6 && cc === size - 7) || (cr === size - 7 && cc === 6)) continue;
        for (var dr2 = -2; dr2 <= 2; dr2++) {
          for (var dc2 = -2; dc2 <= 2; dc2++) {
            var dark2 = Math.max(Math.abs(dr2), Math.abs(dc2)) !== 1;
            setFn(cr + dr2, cc + dc2, dark2 ? 1 : 0);
          }
        }
      }
    }

    // 固定深色模块 + 预留格式信息区
    setFn(size - 8, 8, 1);
    for (var k = 0; k <= 8; k++) {
      if (k !== 6) {
        reserved[8][k] = 1;
        reserved[k][8] = 1;
      }
    }
    for (var k2 = 0; k2 < 8; k2++) {
      reserved[8][size - 1 - k2] = 1;
      reserved[size - 1 - k2][8] = 1;
    }
    reserved[8][8] = 1;

    // 版本信息（版本 ≥7）
    if (ver >= 7) {
      var vbits = versionBits(ver);
      for (var i3 = 0; i3 < 18; i3++) {
        var bit = (vbits >> i3) & 1;
        var rr = Math.floor(i3 / 3);
        var cc2 = (i3 % 3) + size - 11;
        setFn(rr, cc2, bit);
        setFn(cc2, rr, bit);
      }
    }

    return { size: size, m: m, reserved: reserved };
  }

  function versionBits(ver) {
    var g = 0x1f25;
    var v = ver << 12;
    for (var i = 0; i < 6; i++) {
      if (v & (1 << (17 - i))) v ^= g << (5 - i);
    }
    // 标准：BCH(18,6)，生成多项式 0x1F25
    var rem = (ver << 12) | 0;
    var d = ver << 12;
    for (var b = 17; b >= 12; b--) {
      if ((d >> b) & 1) d ^= 0x1f25 << (b - 12);
    }
    return ((ver << 12) | d) & 0x3ffff;
  }

  function maskFn(id, r, c) {
    switch (id) {
      case 0:
        return (r + c) % 2 === 0;
      case 1:
        return r % 2 === 0;
      case 2:
        return c % 3 === 0;
      case 3:
        return (r + c) % 3 === 0;
      case 4:
        return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5:
        return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6:
        return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7:
        return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
    return false;
  }

  function formatBits(ecLevelBits, mask) {
    var data = (ecLevelBits << 3) | mask;
    var d = data << 10;
    for (var b = 14; b >= 10; b--) {
      if ((d >> b) & 1) d ^= 0x537 << (b - 10);
    }
    return ((data << 10) | d) ^ 0x5412;
  }

  var EC_BITS_M = 0; // M 级 = 00

  function placeFormat(mtx, mask) {
    var size = mtx.size;
    var m = mtx.m;
    var f = formatBits(EC_BITS_M, mask);
    // 15 位格式信息两个副本：
    //   列 8（左上角竖着）：i=0..5 → (0..5,8)；i=6 → (7,8)；i=7 → (8,8)；i=8..14 → (size-7..size-1,8)
    //   行 8（横向）：i=0..7 → (8,size-1..size-8)；i=8 → (8,7)；i=9..14 → (8,5..0)
    for (var i = 0; i <= 14; i++) {
      var bit = (f >> i) & 1;
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else m[size - 15 + i][8] = bit;

      if (i < 8) m[8][size - 1 - i] = bit;
      else if (i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
    }
    m[size - 8][8] = 1;
  }

  function penalty(m, size) {
    var p = 0;
    // 行/列同色连排
    for (var r = 0; r < size; r++) {
      var run = 1;
      for (var c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) run++;
        else {
          if (run >= 5) p += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) p += 3 + (run - 5);
    }
    for (var c2 = 0; c2 < size; c2++) {
      var run2 = 1;
      for (var r2 = 1; r2 < size; r2++) {
        if (m[r2][c2] === m[r2 - 1][c2]) run2++;
        else {
          if (run2 >= 5) p += 3 + (run2 - 5);
          run2 = 1;
        }
      }
      if (run2 >= 5) p += 3 + (run2 - 5);
    }
    // 2x2 同色块
    for (var r3 = 0; r3 < size - 1; r3++) {
      for (var c3 = 0; c3 < size - 1; c3++) {
        var v = m[r3][c3];
        if (v === m[r3][c3 + 1] && v === m[r3 + 1][c3] && v === m[r3 + 1][c3 + 1]) p += 3;
      }
    }
    // 噪声比
    var dark = 0;
    for (var r4 = 0; r4 < size; r4++) for (var c4 = 0; c4 < size; c4++) dark += m[r4][c4];
    var ratio = (dark * 100) / (size * size);
    p += Math.floor(Math.abs(ratio - 50) / 5) * 10;

    // 定位图案相似序列 1011101 0000 / 0000 1011101，每处 +40
    var P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function hit(seq, pat) {
      for (var i = 0; i < pat.length; i++) if (seq[i] !== pat[i]) return false;
      return true;
    }
    for (var r5 = 0; r5 < size; r5++) {
      for (var c5 = 0; c5 + 11 <= size; c5++) {
        var rowSeg = [];
        for (var k5 = 0; k5 < 11; k5++) rowSeg.push(m[r5][c5 + k5]);
        if (hit(rowSeg, P1) || hit(rowSeg, P2)) p += 40;
      }
    }
    for (var c6 = 0; c6 < size; c6++) {
      for (var r6 = 0; r6 + 11 <= size; r6++) {
        var colSeg = [];
        for (var k6 = 0; k6 < 11; k6++) colSeg.push(m[r6 + k6][c6]);
        if (hit(colSeg, P1) || hit(colSeg, P2)) p += 40;
      }
    }
    return p;
  }

  function encode(text, forceMask) {
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }

    var ver = 1;
    for (; ver <= 10; ver++) {
      if (bytes.length + 2 <= dataCapacity(ver)) break;
    }
    if (ver > 10) throw new Error('内容太长');

    var codewords = buildCodewords(bytes, ver);
    var best = null;

    for (var mask = 0; mask < 8; mask++) {
      if (forceMask != null && mask !== forceMask) continue;
      var base = makeMatrix(ver);
      var size = base.size;
      var m = base.m;
      var reserved = base.reserved;
      var order = [];

      // 数据按之字形填入
      var bitIdx = 0;
      var totalBits = codewords.length * 8;
      var upward = true;
      for (var col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--; // 跳过竖向时序列
        for (var step = 0; step < size; step++) {
          var row = upward ? size - 1 - step : step;
          for (var dx = 0; dx < 2; dx++) {
            var cc = col - dx;
            if (reserved[row][cc]) continue;
            order.push([row, cc]);
            var bit = 0;
            if (bitIdx < totalBits) {
              bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
              bitIdx++;
            }
            if (maskFn(mask, row, cc)) bit ^= 1;
            m[row][cc] = bit;
          }
        }
        upward = !upward;
      }

      placeFormat(base, mask);
      var score = penalty(m, size);
      if (!best || score < best.score) best = { score: score, size: size, modules: m, order: order };
    }

    return best;
  }

  function svg(text, opts) {
    opts = opts || {};
    var quiet = opts.quiet == null ? 2 : opts.quiet;
    var res = encode(text);
    var n = res.size + quiet * 2;
    var d = '';
    for (var r = 0; r < res.size; r++) {
      for (var c = 0; c < res.size; c++) {
        if (res.modules[r][c]) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      n +
      ' ' +
      n +
      '" shape-rendering="crispEdges"><rect width="' +
      n +
      '" height="' +
      n +
      '" fill="#fff"/><path d="' +
      d +
      '" fill="#0a0a0d"/></svg>'
    );
  }

  root.MFlixQR = { encode: encode, svg: svg };
})(typeof window !== 'undefined' ? window : this);
