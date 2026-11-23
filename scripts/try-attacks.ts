// Fire the attack lab's attacks once each against the live chain, without starting the server
// (a second server would be a second operator). Prints each refusal.
//   BLIND_ENV=<path> DATA_DIR=<dir> npx tsx scripts/try-attacks.ts [name ...]
import { AttackLab, ATTACKS } from "../server/attacks.ts";

const lab = await AttackLab.create();
if (typeof lab === "string") { console.log(lab); process.exit(1); }
const names = process.argv.slice(2).length ? process.argv.slice(2) : ATTACKS.map((a) => a.name);
let bad = 0;
for (const n of names) {
  // The live server commits through the same agent key; stay clear of a batch that is about to commit.
  if (n.startsWith("steal-agent-key")) {
    for (let i = 0; i < 40; i++) {
      const s = await fetch("https://blind.jdollar.site/api/state").then((r) => r.json()).catch(() => null) as any;
      if (!s || !["intake", "quoting"].includes(s.phase)) break;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
  try {
    const r = await lab.run(n);
    if (r.succeeded) bad++;
    console.log(`${r.succeeded ? "GOT THROUGH" : "REFUSED"}  ${n}  by ${r.refusedBy}  tx ${r.txHash} block ${r.block}\n    ${r.chainSays}\n    ${r.reason}`);
  } catch (e: any) { bad++; console.log(`ERROR ${n}: ${String(e.shortMessage ?? e.message).slice(0, 300)}`); }
}
process.exit(bad ? 1 : 0);
