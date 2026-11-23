import { useState } from "react";
import { usePoll, TxLink, agoWords, Link } from "../ui";
import "./attack.css";

// "Try to rob Blind": every button sends one real transaction on QoreChain testnet (server/attacks.ts).
type RefusedBy = "chain rule" | "contract" | "signature check";
interface Result {
  name: string; title: string; attempted: string; refusedBy: RefusedBy | null; succeeded: boolean;
  reason: string; chainSays?: string; txHash?: string; block?: number; fingerprint?: string; dryRun?: boolean; at: string;
}
interface Lab {
  available: boolean; note: string | null;
  totals: { tried: number; refused: number; succeeded: number };
  attacks: { name: string; title: string; tries: string }[];
  log: Result[];
}

const BY: Record<RefusedBy, string> = {
  "chain rule": "Refused by QoreChain's rule on the agent's key",
  contract: "Refused by the Blind contract",
  "signature check": "Refused by the quantum safe signature check",
};

async function getLab(): Promise<Lab> {
  const r = await fetch("/api/attacks");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export default function Attack() {
  const [tick, setTick] = useState(0);
  const { v: lab, err } = usePoll(getLab, 15000, [tick]);
  const [busy, setBusy] = useState<string | null>(null);
  const [mine, setMine] = useState<Record<string, Result>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});

  const tryIt = async (name: string) => {
    setBusy(name);
    setErrs((e) => ({ ...e, [name]: "" }));
    try {
      const r = await fetch(`/api/attack/${name}`, { method: "POST" });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error ?? `The server answered ${r.status}.`);
      setMine((m) => ({ ...m, [name]: b as Result }));
      setTick((t) => t + 1);
    } catch (e: any) {
      setErrs((x) => ({ ...x, [name]: e.message }));
    } finally { setBusy(null); }
  };

  const t = lab?.totals;
  const last = (name: string) => mine[name] ?? lab?.log.find((x) => x.name === name) ?? null;

  return (
    <div className="page wrap rob">
      <div className="apphead">
        <h1>Try to rob Blind</h1>
        <p>Each button sends one real transaction on QoreChain testnet: from our attacker account, or signed with the market maker agent's real key. Press one and see who stops it.</p>
      </div>

      <div className="figs three">
        <div><b>{t ? t.tried.toLocaleString() : "…"}</b><span>attempts so far</span></div>
        <div><b>{t ? t.refused.toLocaleString() : "…"}</b><span>refused on chain</span></div>
        <div><b className={t && t.succeeded > 0 ? "neg" : ""}>{t ? t.succeeded.toLocaleString() : "…"}</b><span>got through</span></div>
      </div>
      {err && !lab && <div className="msg err">The attack log is not answering. Retrying.</div>}
      {lab && !lab.available && <div className="msg">{lab.note ?? "The attack lab is resting right now."} The record below is still real.</div>}

      <ol className="robs">
        {(lab?.attacks ?? []).map((a, i) => {
          const r = last(a.name);
          const fresh = !!mine[a.name];
          const running = busy === a.name;
          return (
            <li key={a.name} className={`robr ${running ? "run" : ""}`}>
              <span className="n">{String(i + 1).padStart(2, "0")}</span>
              <div className="what">
                <h3>{a.title}</h3>
                <p>{a.tries}</p>
              </div>
              <div className="act">
                <button className="btn day" disabled={!!busy || !lab?.available} onClick={() => tryIt(a.name)}>
                  {running ? "Sending" : "Try it"}
                </button>
              </div>
              <div className="res" aria-live="polite">
                {running && <p className="wait">Signing and sending to QoreChain. A block takes about two seconds.</p>}
                {!running && errs[a.name] && <p className="msg err">{errs[a.name]}</p>}
                {!running && r && (
                  <div className={`out ${r.succeeded ? "hit" : ""}`}>
                    <div className="by">
                      <span className="mark" aria-hidden />
                      <b>{r.succeeded ? "It got through" : r.refusedBy ? BY[r.refusedBy] : "Refused"}</b>
                      <span className="when">{fresh ? "your attempt, just now" : `last tried ${agoWords(r.at)}`}</span>
                    </div>
                    <p>{r.reason}</p>
                    <div className="ev">
                      {r.txHash && <TxLink h={r.txHash} label={r.dryRun ? "dry run against the live contract" : `see the refusal on chain, block ${r.block?.toLocaleString() ?? ""}`} />}
                      {r.chainSays && (
                        <details>
                          <summary>What the chain said</summary>
                          <code>{r.chainSays}</code>
                        </details>
                      )}
                    </div>
                  </div>
                )}
                {!running && !r && !errs[a.name] && <p className="dim small">Nobody has tried this one yet.</p>}
              </div>
            </li>
          );
        })}
        {!lab && !err && <li className="empty">Reading the attack log.</li>}
      </ol>

      {lab && lab.log.length > 0 && (
        <section className="vfix">
          <h2>Everyone's attempts</h2>
          <div className="atks">
            {lab.log.slice(0, 15).map((r, i) => (
              <div className="atk" key={`${r.txHash}${i}`}>
                <span className="when">{agoWords(r.at)}</span>
                <span className="what">{r.title}</span>
                <span className={`oc ${r.succeeded ? "hit" : ""}`}>{r.succeeded ? "Got through" : r.refusedBy ? BY[r.refusedBy] : "Refused"}</span>
                <span className="atkl">{r.txHash && <TxLink h={r.txHash} label="on chain" />}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="small dim robfoot">Testnet tokens only. The attacker account is ours and pays its own fees. Want the rules behind each refusal? <Link to="/proof#agent">See the agent's leash</Link> or read the contract on <a href="https://github.com/jenzylove/blind/blob/main/contracts/BlindSettlement.sol" target="_blank" rel="noreferrer">GitHub</a>.</p>
    </div>
  );
}
