export function projectRules(include, exclude, conditions) {
  const all = [];
  const any = [];
  const not = [];
  for (const row of conditions || []) {
    if (row.bucket === "all") all.push(row.term);
    else if (row.bucket === "any") any.push(row.term);
    else if (row.bucket === "not") not.push(row.term);
  }
  return {
    include: (include || []).map((row) => row.term),
    exclude: (exclude || []).map((row) => row.term),
    all,
    any,
    not,
  };
}

export function textMatches(text, rules) {
  const hay = String(text || "").toLowerCase();
  const has = (term) => hay.includes(String(term || "").toLowerCase());
  if (rules.exclude.some(has) || rules.not.some(has)) return false;
  if (rules.all.length && !rules.all.every(has)) return false;
  if (rules.any.length && !rules.any.some(has)) return false;
  const bucketsEmpty = rules.all.length === 0 && rules.any.length === 0;
  if (bucketsEmpty && rules.include.length && !rules.include.some(has)) return false;
  if (bucketsEmpty && rules.include.length === 0 && rules.not.length === 0 && rules.exclude.length === 0) {
    return false;
  }
  return true;
}
