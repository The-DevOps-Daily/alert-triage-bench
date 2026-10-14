// mulberry32: small, fast and sound in JavaScript (Math.imul keeps it in 32 bits).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function helpers(rand) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const between = (lo, hi, digits = 0) => {
    const v = lo + rand() * (hi - lo);
    const f = 10 ** digits;
    return Math.round(v * f) / f;
  };
  const int = (lo, hi) => Math.floor(lo + rand() * (hi - lo + 1));
  const chance = (p) => rand() < p;
  const shuffle = (xs) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  return { pick, between, int, chance, shuffle };
}
