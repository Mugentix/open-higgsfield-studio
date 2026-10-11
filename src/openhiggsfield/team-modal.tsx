"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { clearTeamKey, saveTeamKey, type KeyStatus } from "@/generation/actions";
import type { SpendLine, SpendReport } from "@/server/spend";
import { DEFAULT_SPEND_DAYS, SPEND_PERIODS, type SpendDays } from "@/server/spend-periods";
import {
  cancelInvitation,
  inviteMember,
  removeMember,
  setMemberRole,
  signOut,
  type TeamOverview,
} from "@/server/team-actions";
import type { Role } from "@/server/team";

import { CloseIcon } from "./icons";
import { readStudio } from "./studio-read";

const ROLE_LABELS: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/* The team behind the sidebar's gear: who is in it, who is on the way, the
   KIE key every generation runs on, and the way out. Owners and admins change
   things; members see them. */
export function TeamModal({
  onClose,
  onKeyChanged,
}: {
  onClose: () => void;
  onKeyChanged: (status: KeyStatus) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [team, setTeam] = useState<TeamOverview | null>(null);
  const [key, setKey] = useState<KeyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* Opened from the sidebar's gear — or by the studio itself while the team
     has no key, when there is no opener to return to — and focus goes back
     to whatever opened it on the way out, unless something else took it
     first. The opener is read once into a ref: React runs this effect twice
     in development, and a second read would find the dialog's own panel. */
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal();
    panelRef.current?.focus();
    return () => {
      if (document.activeElement === null || document.activeElement === document.body) opener.current?.focus();
    };
  }, []);

  useEffect(() => {
    void reload();
  }, []);

  async function reload() {
    const [overview, status] = await Promise.all([readStudio("team"), readStudio("key-status")]);
    if (overview.ok) setTeam(overview.data);
    else setError(overview.error);
    if (status.ok) setKey(status.data);
  }

  async function onSignOut() {
    await signOut();
    window.location.assign("/login");
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="ohf-team-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div ref={panelRef} tabIndex={-1} className="ohf-dialog-panel ohf-keys-panel ohf-team-panel">
        <div className="ohf-keys-head">
          <div>
            <div id="ohf-team-title" className="ohf-keys-title">
              {team?.teamName ?? "Team"}
            </div>
            <p className="ohf-keys-copy">
              {team ? `You are ${team.me.name || team.me.email} · ${ROLE_LABELS[team.me.role]}` : "Loading…"}
            </p>
          </div>
          <button type="button" className="ohf-icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="ohf-team-body">
          {error && (
            <div className="ohf-alert" role="alert">
              <span className="ohf-alert-text">{error}</span>
            </div>
          )}

          {team && (
            <>
              <KeySection
                status={key}
                canManage={team.me.canManage}
                onChanged={(next) => {
                  setKey(next);
                  onKeyChanged(next);
                }}
              />
              <SpendSection />
              <MembersSection team={team} onChanged={() => void reload()} />
              {team.me.canManage && <InviteSection onInvited={() => void reload()} />}
            </>
          )}

          <div className="ohf-keys-actions ohf-team-foot">
            <button type="button" className="ohf-btn-quiet" onClick={() => void onSignOut()}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}

function KeySection({
  status,
  canManage,
  onChanged,
}: {
  status: KeyStatus | null;
  canManage: boolean;
  onChanged: (next: KeyStatus) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const line = !status
    ? "…"
    : status.source === "team"
      ? `Team key ending in ${status.last4}`
      : status.source === "env"
        ? "The deployment's key"
        : "No key yet";

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await saveTeamKey({ apiKey });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setApiKey("");
    setEditing(false);
    onChanged(result.data);
  }

  async function onClear() {
    setBusy(true);
    const result = await clearTeamKey();
    setBusy(false);
    if (result.ok) onChanged(result.data);
    else setError(result.error);
  }

  return (
    <section className="ohf-team-section">
      <div className="ohf-field-row">
        <div className="ohf-field-label">KIE API key</div>
        <div className="ohf-field-value" data-on={status?.source !== null}>
          {line}
        </div>
      </div>
      {canManage && !editing && (
        <div className="ohf-team-row-actions">
          <button type="button" className="ohf-btn-quiet" onClick={() => setEditing(true)}>
            {status?.source === "team" ? "Replace key" : "Set team key"}
          </button>
          {status?.source === "team" && (
            <button type="button" className="ohf-btn-quiet" disabled={busy} onClick={() => void onClear()}>
              Remove
            </button>
          )}
        </div>
      )}
      {canManage && editing && (
        <form className="ohf-team-inline" onSubmit={(event) => void onSave(event)}>
          <input
            className="ohf-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the key from kie.ai/api-key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoFocus
          />
          <button type="submit" className="ohf-keys-save" disabled={busy || !apiKey.trim()}>
            {busy ? "Checking…" : "Save"}
          </button>
          <button type="button" className="ohf-btn-quiet" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
    </section>
  );
}

const CREDITS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const DAY_LABEL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function formatCredits(value: number): string {
  return CREDITS.format(value);
}

function dayLabel(day: string): string {
  return DAY_LABEL.format(new Date(`${day}T00:00:00Z`));
}

/* Where the credits went: the account's balance, then the window's total
   split by who pressed Generate and by product, with one bar per day. Numbers
   here are measurement, not emphasis, so nothing in the section takes the
   accent; the period control borrows the asset shelf's tabs. */
function SpendSection() {
  const [days, setDays] = useState<SpendDays>(DEFAULT_SPEND_DAYS);
  const [report, setReport] = useState<SpendReport | null>(null);
  /* undefined while KIE is being asked; null when the account cannot say. */
  const [balance, setBalance] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void readStudio("credits").then((result) => setBalance(result.ok ? result.data : null));
  }, []);

  useEffect(() => {
    let current = true;
    void readStudio("spend", { days }).then((result) => {
      if (!current) return;
      if (result.ok) {
        setReport(result.data);
        setError(null);
      } else setError(result.error);
    });
    return () => {
      current = false;
    };
  }, [days]);

  function onPeriodKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = SPEND_PERIODS.indexOf(days);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = SPEND_PERIODS[(index + step + SPEND_PERIODS.length) % SPEND_PERIODS.length]!;
    setDays(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-days="${next}"]`)?.focus();
  }

  const peak = report ? Math.max(0, ...report.byDay.map((entry) => entry.credits)) : 0;
  const first = report?.byDay[0];

  return (
    <section className="ohf-team-section">
      <div className="ohf-field-row">
        <div className="ohf-field-label">Spend</div>
        <div className="ohf-field-value">
          {balance === undefined ? "…" : balance === null ? "Balance unavailable" : `Balance ${formatCredits(balance)} credits`}
        </div>
      </div>
      <div className="ohf-assets-tabs ohf-spend-periods" role="tablist" aria-label="Period" onKeyDown={onPeriodKeyDown}>
        {SPEND_PERIODS.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={option === days}
            tabIndex={option === days ? 0 : -1}
            data-days={option}
            className="ohf-assets-tab"
            onClick={() => setDays(option)}
          >
            {option} days
          </button>
        ))}
      </div>
      {report && report.runs > 0 && (
        <>
          <p className="ohf-spend-total">
            <strong>{formatCredits(report.total)}</strong> credits · {report.runs} {report.runs === 1 ? "run" : "runs"} in the last{" "}
            {report.days} days
          </p>
          <div className="ohf-spend-strip" role="img" aria-label={`Credits per day over the last ${report.days} days`}>
            {report.byDay.map((entry) => (
              <span
                key={entry.day}
                className="ohf-spend-bar"
                data-spent={entry.credits > 0}
                style={{ height: peak > 0 ? `${(entry.credits / peak) * 100}%` : 0 }}
                title={`${dayLabel(entry.day)} · ${formatCredits(entry.credits)} credits`}
              />
            ))}
          </div>
          <div className="ohf-spend-axis" aria-hidden="true">
            <span>{first ? dayLabel(first.day) : ""}</span>
            <span>Today</span>
          </div>
          <div className="ohf-spend-tables">
            <SpendTable label="Member" lines={report.byMember} />
            <SpendTable label="Product" lines={report.byProduct} />
          </div>
        </>
      )}
      {report && report.runs === 0 && <p className="ohf-keys-copy">No spend recorded yet — credits appear here once runs settle.</p>}
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
    </section>
  );
}

function SpendTable({ label, lines }: { label: string; lines: SpendLine[] }) {
  return (
    <table className="ohf-spend-table">
      <colgroup>
        <col />
        <col className="ohf-spend-col--runs" />
        <col className="ohf-spend-col--credits" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">{label}</th>
          <th scope="col">Runs</th>
          <th scope="col">Credits</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id || "none"}>
            <th scope="row" title={line.name}>
              {line.name}
            </th>
            <td>{line.runs}</td>
            <td>{formatCredits(line.credits)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MembersSection({ team, onChanged }: { team: TeamOverview; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);

  async function act(promise: Promise<{ ok: boolean; error?: string }>) {
    const result = await promise;
    if (!result.ok) setError(result.error ?? "That did not work");
    else {
      setError(null);
      onChanged();
    }
  }

  return (
    <section className="ohf-team-section">
      <div className="ohf-field-row">
        <div className="ohf-field-label">Members</div>
        <div className="ohf-field-value">{team.members.length}</div>
      </div>
      <ul className="ohf-team-list">
        {team.members.map((member) => (
          <li key={member.memberId} className="ohf-team-row">
            <div className="ohf-team-who">
              <span className="ohf-team-name">{member.name || member.email}</span>
              <span className="ohf-team-mail">{member.email}</span>
            </div>
            {team.me.canManage && !member.isSelf ? (
              <select
                className="ohf-team-role"
                aria-label={`Role of ${member.email}`}
                value={member.role}
                onChange={(event) => void act(setMemberRole({ memberId: member.memberId, role: event.target.value }))}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                {team.me.role === "owner" && <option value="owner">Owner</option>}
              </select>
            ) : (
              <span className="ohf-team-role-text">{ROLE_LABELS[member.role]}</span>
            )}
            {team.me.canManage && !member.isSelf && (
              <button
                type="button"
                className="ohf-icon-btn ohf-icon-btn--ghost"
                aria-label={`Remove ${member.email}`}
                title="Remove from team"
                onClick={() => void act(removeMember(member.memberId))}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </li>
        ))}
        {team.invitations.map((invite) => (
          <li key={invite.id} className="ohf-team-row ohf-team-row--pending">
            <div className="ohf-team-who">
              <span className="ohf-team-name">{invite.email}</span>
              <span className="ohf-team-mail">Invited · {ROLE_LABELS[invite.role]}</span>
            </div>
            <span className="ohf-team-role-text">Pending</span>
            {team.me.canManage && (
              <button
                type="button"
                className="ohf-icon-btn ohf-icon-btn--ghost"
                aria-label={`Withdraw the invitation for ${invite.email}`}
                title="Withdraw invitation"
                onClick={() => void act(cancelInvitation(invite.id))}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
    </section>
  );
}

function InviteSection({ onInvited }: { onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await inviteMember({ email, role });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSent(result.data.email);
    setEmail("");
    onInvited();
  }

  return (
    <section className="ohf-team-section">
      <div className="ohf-field-label">Invite</div>
      <form className="ohf-team-inline" onSubmit={(event) => void onSubmit(event)}>
        <input
          className="ohf-input"
          type="email"
          placeholder="name@company.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <select
          className="ohf-team-role"
          aria-label="Role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" className="ohf-keys-save" disabled={busy || !email.trim()}>
          {busy ? "Sending…" : "Invite"}
        </button>
      </form>
      {sent && <p className="ohf-keys-copy">Invitation sent to {sent}.</p>}
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
    </section>
  );
}
