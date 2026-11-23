// Tiny stack VM for make.fun's tiny-stack-vm-01 bounty.
// Runs every program in the input directory and writes each program's output
// bytes and exit code. Implements generator/subject/ISA.md exactly: 32-bit
// wrapping arithmetic, a 256-value data stack, a 64-deep call stack, 256 words
// of memory, input/output, and the ten traps with their own exit codes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STEP_LIMIT = 1000000;
const OUT_LIMIT = 65536;
const STACK_MAX = 256;
const CALL_MAX = 64;
const MEM_WORDS = 256;

// Opcode byte -> [immediate bytes, values popped, values pushed].
const SPEC = {
  0: [0, 0, 0], 1: [1, 0, 1], 2: [4, 0, 1], 3: [0, 1, 0], 4: [0, 1, 2],
  5: [0, 2, 2], 6: [0, 2, 3], 7: [0, 3, 3],
  16: [0, 2, 1], 17: [0, 2, 1], 18: [0, 2, 1], 19: [0, 2, 1],
  20: [0, 2, 1], 21: [0, 2, 1], 22: [0, 2, 1], 23: [0, 1, 1],
  24: [0, 2, 1], 25: [0, 2, 1], 26: [0, 2, 1], 27: [0, 1, 1],
  28: [0, 2, 1], 29: [0, 2, 1], 30: [0, 2, 1],
  32: [0, 2, 1], 33: [0, 2, 1], 34: [0, 2, 1],
  48: [2, 0, 0], 49: [2, 1, 0], 50: [2, 1, 0], 51: [2, 0, 0], 52: [0, 0, 0],
  64: [0, 1, 1], 65: [0, 2, 0],
  80: [0, 1, 0], 81: [0, 1, 0], 82: [0, 0, 1], 83: [0, 1, 0],
};

function run(prog, input) {
  const n = prog.length;
  const st = new Int32Array(STACK_MAX);
  const cs = new Int32Array(CALL_MAX);
  const mem = new Int32Array(MEM_WORDS);
  const out = new Uint8Array(OUT_LIMIT);
  let sp = 0, cp = 0, olen = 0, ipos = 0, pc = 0, steps = 0;
  const end = (code) => ({ out: out.slice(0, olen), code });
  for (;;) {
    if (steps === STEP_LIMIT) return end(10);
    if (pc < 0 || pc >= n) return end(9);
    const spec = SPEC[prog[pc]];
    if (!spec) return end(5);
    const op = prog[pc];
    const imm = spec[0];
    if (pc + imm >= n) return end(9);
    steps++;
    const next = pc + 1 + imm;
    if (sp < spec[1]) return end(2);
    if (sp - spec[1] + spec[2] > STACK_MAX) return end(3);
    pc = next;
    if (op === 0) return end(0);
    if (op === 1) { st[sp++] = (prog[next - 1] << 24) >> 24; continue; }
    if (op === 2) {
      st[sp++] = prog[next - 4] | (prog[next - 3] << 8) | (prog[next - 2] << 16) | (prog[next - 1] << 24);
      continue;
    }
    if (op === 3) { sp--; continue; }
    if (op === 4) { st[sp] = st[sp - 1]; sp++; continue; }
    if (op === 5) { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; continue; }
    if (op === 6) { st[sp] = st[sp - 2]; sp++; continue; }
    if (op === 7) {
      const a = st[sp - 3]; st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a;
      continue;
    }
    if (op === 23) { st[sp - 1] = (-st[sp - 1]) | 0; continue; }
    if (op === 27) { st[sp - 1] = ~st[sp - 1]; continue; }
    if (op >= 48 && op <= 50) {
      const rel = ((prog[next - 2] | (prog[next - 1] << 8)) << 16) >> 16;
      let take = true;
      if (op !== 48) { const v = st[--sp]; take = op === 49 ? v === 0 : v !== 0; }
      if (take) pc = next + rel;
      continue;
    }
    if (op === 51) {
      if (cp === CALL_MAX) return end(7);
      cs[cp++] = next;
      pc = prog[next - 2] | (prog[next - 1] << 8);
      continue;
    }
    if (op === 52) {
      if (cp === 0) return end(8);
      pc = cs[--cp];
      continue;
    }
    if (op === 64) {
      const addr = st[sp - 1];
      if (addr < 0 || addr >= MEM_WORDS) return end(6);
      st[sp - 1] = mem[addr];
      continue;
    }
    if (op === 65) {
      const addr = st[sp - 1];
      if (addr < 0 || addr >= MEM_WORDS) return end(6);
      mem[addr] = st[sp - 2];
      sp -= 2;
      continue;
    }
    if (op === 80) {
      const s = String(st[sp - 1]);
      if (olen + s.length > OUT_LIMIT) return end(11);
      sp--;
      for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i);
      continue;
    }
    if (op === 81) {
      if (olen + 1 > OUT_LIMIT) return end(11);
      out[olen++] = st[--sp] & 255;
      continue;
    }
    if (op === 82) { st[sp++] = ipos < input.length ? input[ipos++] : -1; continue; }
    if (op === 83) return end(st[--sp] & 255);
    // Two-operand arithmetic, comparison and shift ops.
    const b = st[sp - 1];
    const a = st[sp - 2];
    let r;
    if (op === 16) r = (a + b) | 0;
    else if (op === 17) r = (a - b) | 0;
    else if (op === 18) r = Math.imul(a, b);
    else if (op === 19) {
      if (b === 0) return end(4);
      r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
    } else if (op === 20) {
      if (b === 0) return end(4);
      r = b === -1 ? 0 : (a % b) | 0;
    } else if (op === 21) {
      if (b === 0) return end(4);
      r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
    } else if (op === 22) {
      if (b === 0) return end(4);
      r = ((a >>> 0) % (b >>> 0)) | 0;
    } else if (op === 24) r = a & b;
    else if (op === 25) r = a | b;
    else if (op === 26) r = a ^ b;
    else if (op === 28) r = a << (b & 31);
    else if (op === 29) r = a >> (b & 31);
    else if (op === 30) r = (a >>> (b & 31)) | 0;
    else if (op === 32) r = a === b ? 1 : 0;
    else if (op === 33) r = a < b ? 1 : 0;
    else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
    sp -= 2;
    st[sp++] = r;
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(
    new Uint8Array(readFileSync(join(I, id, 'program.bin'))),
    new Uint8Array(readFileSync(join(I, id, 'input.bin'))),
  );
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), r.code + '\n');
}
