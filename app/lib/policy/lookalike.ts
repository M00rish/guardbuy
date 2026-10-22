// Lookalike supplier names ("Atlas Roasters Co.", "Atlas Roasterz", "Atlas-Roasters") for the
// new-supplier rule. Pure and deterministic, shared by the policy context and its checks.

// Words that don't make two businesses different ("Co.", "Inc", "Ltd", "LLC", "the").
const FILLER = /\b(the|co|company|inc|incorporated|ltd|limited|llc|llp|gmbh|sarl|sa|plc|corp|corporation|group|intl|international)\b/g;

export function normalizeName(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // é -> e
    .replace(/[0o]/g, "o").replace(/[1l|i]/g, "l") // look-alike characters
    .replace(/&/g, " and ")
    .replace(FILLER, " ")
    .replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** The older supplier this name imitates, or null. Names shorter than 5 letters are never compared. */
export function lookalikeOf(name: string, olderNames: string[]): string | null {
  const n = normalizeName(name);
  if (n.length < 5) return null;
  for (const other of olderNames) {
    const o = normalizeName(other);
    if (o.length < 5) continue;
    // Same name once filler words and punctuation are gone, one or two letters off, or one name
    // wrapped inside the other ("Atlas Roasters Billing").
    const allowed = Math.min(n.length, o.length) >= 10 ? 2 : 1;
    if (n === o || editDistance(n, o) <= allowed || (o.length >= 6 && n.includes(o))) return other;
  }
  return null;
}
