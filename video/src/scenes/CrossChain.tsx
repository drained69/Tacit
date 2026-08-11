import React from "react";
import { c, code } from "../theme";
import { Heading, Panel, Pill, Reveal, Stage } from "../components/ui";

/* ── 13. Cross-chain deposits ─────────────────────────────────────────── */

/** Everything on these two slides is traceable to
 *  `src/ovault/TacitOVaultComposer.sol` and `src/ovault/TacitShareOFTAdapter.sol`.
 *  Two claims are deliberately NOT made, because the repo cannot support them:
 *  that any of this is deployed, and that a LayerZero route to a second chain
 *  exists. There is no endpoint address, no EID and no OFT adapter address
 *  anywhere in the repo — only the three `@layerzerolabs/*` dependencies and the
 *  contracts themselves. The pills below say so, scene 14's eyebrow repeats it, and
 *  scene 15 lists the same status in the honesty table. If that changes, the pills
 *  change first.
 *
 *  Split across two scenes on purpose. The first is the journey a depositor
 *  takes; the second is what had to be hardened to make that journey safe. Those
 *  are different questions, and the single slide that tried to answer both
 *  compressed the second one into one sentence of a side panel. */

const STEPS = [
  {
    n: "01",
    where: "On the other chain",
    title: "FXRP leaves with instructions attached",
    body:
      "The depositor sends FXRP toward Coston2 and attaches a message describing what to do on arrival. One signature, on the chain they already hold funds on. They never acquire Coston2 gas.",
    color: c.s1,
  },
  {
    n: "02",
    where: "On Coston2",
    title: "The composer calls the ordinary deposit",
    body:
      "LayerZero delivers the FXRP here together with the message. The composer turns it into TacitVault.deposit() — the same function the web interface calls, behind the same five guardrails.",
    color: c.accent,
  },
  {
    n: "03",
    where: "Back where they started",
    title: "The shares follow the depositor home",
    body:
      "Shares leave the vault, are locked in the share adapter, and appear on the chain the deposit came from. Redeeming is the same three steps in reverse, ending in FXRP.",
    color: c.s3,
  },
];

export const SceneCrossChain: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="Cross-chain deposits · LayerZero OVault"
      title="A depositor on another chain is still just a depositor"
      sub="The vault only exists on Coston2, and it should stay that way. So instead of copying it, the deposit travels to it."
    />

    <Reveal delay={26}>
      <div style={{ display: "flex", gap: 12, marginBottom: 26, flexWrap: "wrap" }}>
        <Pill color={c.warn}>◇ WRITTEN AND COMPILING · NOT YET DEPLOYED</Pill>
        <Pill color={c.dim}>NO SPOKE CHAIN WIRED · NO LAYERZERO ROUTE CONFIGURED</Pill>
      </div>
    </Reveal>

    <div style={{ display: "flex", alignItems: "stretch" }}>
      {STEPS.map((s, i) => (
        <React.Fragment key={s.n}>
          {i > 0 && (
            <Reveal
              delay={40 + i * 34}
              style={{ display: "flex", alignItems: "center", padding: "0 12px" }}
            >
              <div style={{ fontSize: 34, color: c.dim, lineHeight: 1 }}>›</div>
            </Reveal>
          )}
          <Reveal delay={48 + i * 34} style={{ flex: 1, display: "flex" }}>
            <Panel accent={s.color} style={{ padding: "22px 26px", flex: 1 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
                <span
                  style={{ fontFamily: code, fontSize: 20, color: s.color, letterSpacing: "0.1em" }}
                >
                  {s.n}
                </span>
                <span
                  style={{
                    fontFamily: code,
                    fontSize: 16,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: c.dim,
                  }}
                >
                  {s.where}
                </span>
              </div>
              <div style={{ fontSize: 25, fontWeight: 600, lineHeight: 1.25, marginBottom: 12 }}>
                {s.title}
              </div>
              <div style={{ fontSize: 20, color: c.muted, lineHeight: 1.5 }}>{s.body}</div>
            </Panel>
          </Reveal>
        </React.Fragment>
      ))}
    </div>

    <Reveal delay={150}>
      <Panel style={{ padding: "26px 30px", marginTop: 26 }}>
        <div
          style={{
            fontFamily: code,
            fontSize: 17,
            letterSpacing: "0.14em",
            color: c.s3,
            marginBottom: 16,
          }}
        >
          THE ONE DECISION THAT MATTERED
        </div>
        <div style={{ fontSize: 23, color: c.muted, lineHeight: 1.55 }}>
          Shares are <span style={{ color: c.text }}>locked</span> on the way out, never burned and
          re-minted. A share token's total supply is one half of the exchange rate every depositor is
          priced against — destroying supply on one chain and recreating it on another would quietly
          rewrite that rate for everyone who never left. Locking keeps supply constant and moves only
          custody. LayerZero's composer <span style={{ color: c.text }}>refuses to deploy</span>{" "}
          against a share token that burns, so this is enforced at construction rather than remembered
          by a human.
        </div>
      </Panel>
    </Reveal>

    <div style={{ flex: 1 }} />

    {/* Hands off to the next scene. Naming the shape of the risk here is what earns
     *  that slide — without this, five overrides read as unmotivated release notes. */}
    <Reveal delay={186}>
      <div style={{ fontSize: 25, color: c.muted, lineHeight: 1.55 }}>
        One thing here is unlike the rest of the system. Everywhere else a failed check simply undoes
        the transaction — but a bridge{" "}
        <span style={{ color: c.text }}>
          delivers the value first and finds out whether the action works second
        </span>
        . Every failure mode on this path is that same shape, and each one needed an answer.
      </div>
    </Reveal>
  </Stage>
);

/* ── 14. Cross-chain safety ───────────────────────────────────────────── */

/** Four failure modes, five overrides, read straight from the two contracts: four
 *  in `TacitOVaultComposer` (`_depositAndSend`, `_redeemAndSend`, `_sendLocal`,
 *  `_refund`) and one in `TacitShareOFTAdapter` (`_credit`). The first row carries
 *  two override names because the deposit and redeem paths lose the depositor's
 *  slippage bound the same way and are fixed the same way — one failure mode, two
 *  functions.
 *
 *  The middle column states what THESE contracts do — never what upstream does.
 *  Upstream behaviour moves between `@layerzerolabs/ovault-evm` releases, and this
 *  deck should not put a claim about a dependency version on screen that it does
 *  not also show. */
const HARDENING = [
  {
    when: "Fewer shares come back than the depositor signed for",
    does:
      "The composer measures the shares the vault actually minted, checks them against the depositor's own minimum, and reattaches that minimum to the outbound send — so the bound they signed survives the bridge.",
    where: "_depositAndSend\n_redeemAndSend",
  },
  {
    when: "The shares are staying on Coston2",
    does:
      "There is no second hop to pay for, so the native gas the depositor pre-paid is returned to them instead of accumulating inside the composer.",
    where: "_sendLocal",
  },
  {
    when: "The refund itself fails",
    does:
      "The tokens move to a recovery address and an event records who they were for — rather than reverting inside LayerZero's delivery and pinning the value where nobody can reach it.",
    where: "_refund",
  },
  {
    when: "Shares arrive for an address that cannot receive them",
    does:
      "The credit never reverts. A failed transfer sends the shares to the recovery address and names the intended recipient and source chain in an event; a reverting credit would strand the whole message.",
    where: "_credit\n(share adapter)",
  },
];

export const SceneCrossChainSafety: React.FC = () => (
  <Stage>
    <Heading
      eyebrow="Cross-chain deposits · what had to change · nothing deployed yet"
      title="Value arrives before anyone knows the action works"
      sub="Four ways that goes wrong, the five overrides that answer them, and one asymmetry that is deliberate."
    />

    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "340px 1fr 250px",
          gap: 18,
          fontFamily: code,
          fontSize: 17,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: c.dim,
          padding: "0 24px 12px",
          borderBottom: `1px solid ${c.line}`,
        }}
      >
        <div>If this happens</div>
        <div>What the contract does</div>
        <div>Override</div>
      </div>

      {HARDENING.map((h, i) => (
        <Reveal key={h.where} delay={40 + i * 30}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "340px 1fr 250px",
              gap: 18,
              alignItems: "center",
              padding: "16px 24px",
              borderBottom: `1px solid ${c.line}`,
              background: i % 2 ? "transparent" : c.panel,
            }}
          >
            <div style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.35 }}>{h.when}</div>
            <div style={{ fontSize: 20, color: c.muted, lineHeight: 1.45 }}>{h.does}</div>
            <div
              style={{
                fontFamily: code,
                fontSize: 18,
                color: c.accent,
                lineHeight: 1.4,
                whiteSpace: "pre-line",
              }}
            >
              {h.where}
            </div>
          </div>
        </Reveal>
      ))}
    </div>

    <div style={{ display: "flex", gap: 24, marginTop: 20 }}>
      <Reveal delay={172} style={{ flex: 1, display: "flex" }}>
        <Panel accent={c.warn} style={{ padding: "22px 26px", flex: 1 }}>
          <div
            style={{
              fontFamily: code,
              fontSize: 17,
              letterSpacing: "0.14em",
              color: c.warn,
              marginBottom: 14,
            }}
          >
            PAUSING IS ASYMMETRIC ON PURPOSE
          </div>
          <div style={{ fontSize: 21, color: c.muted, lineHeight: 1.5 }}>
            Cross-chain deposits can be paused — and while they are,{" "}
            <span style={{ fontFamily: code, fontSize: 19, color: c.text }}>maxDeposit</span> reports
            zero, so a router never sends funds at a closed door. Exits have no pause at all. An
            operator can stop money arriving; nobody can stop it leaving.
          </div>
        </Panel>
      </Reveal>

      <Reveal delay={190} style={{ flex: 1, display: "flex" }}>
        <Panel style={{ padding: "22px 26px", flex: 1 }}>
          <div
            style={{
              fontFamily: code,
              fontSize: 17,
              letterSpacing: "0.14em",
              color: c.s1,
              marginBottom: 14,
            }}
          >
            THE DUST IS DOCUMENTED, NOT HIDDEN
          </div>
          <div style={{ fontSize: 21, color: c.muted, lineHeight: 1.5 }}>
            FXRP has 6 decimals, the share token has 9, and LayerZero moves 6 between chains — so a
            cross-chain share transfer truncates the last three digits.{" "}
            <span style={{ color: c.text }}>At most 999 share units</span>, less than one base unit of
            FXRP, and it stays with the sender.
          </div>
        </Panel>
      </Reveal>
    </div>

    <div style={{ flex: 1 }} />

    <Reveal delay={220}>
      <div style={{ fontSize: 25, color: c.muted, lineHeight: 1.5 }}>
        None of this widens what the agent can do.{" "}
        <span style={{ color: c.text }}>
          Every deposit still enters through the same function, every exit still leaves through the
          same one
        </span>
        , and both are still bounded by the same five guardrails. A cross-chain depositor is an
        ordinary depositor who happened to arrive by bridge.
      </div>
    </Reveal>
  </Stage>
);
