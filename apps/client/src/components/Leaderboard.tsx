import { useMemo, useState } from "react";

import type { LeaderboardEntry } from "@hexonis/shared/events";

export interface LeaderboardProps {
  entries: LeaderboardEntry[];
  currentUserId: string;
  allianceTag: string | null;
  allianceColor: string | null;
  onSetAllianceTag: (tag: string | null) => Promise<boolean>;
}

function formatAllianceTag(tag: string | null): string {
  if (!tag) {
    return "NONE";
  }

  return tag;
}

export function Leaderboard({
  entries,
  currentUserId,
  allianceTag,
  allianceColor,
  onSetAllianceTag,
}: LeaderboardProps): JSX.Element {
  const [draftTag, setDraftTag] = useState(allianceTag ?? "");

  const sortedEntries = useMemo(() => entries.slice(0, 10), [entries]);

  const saveAllianceTag = async (): Promise<void> => {
    const normalized = draftTag.trim().toUpperCase();
    const value = normalized.length > 0 ? normalized : null;
    const ok = await onSetAllianceTag(value);

    if (!ok) {
      return;
    }

    setDraftTag(value ?? "");
  };

  return (
    <aside className="leaderboard-overlay">
      <header className="leaderboard-header">
        <span className="leaderboard-title">Power Ranking</span>
        <span className="leaderboard-sub">Top 10 tiles</span>
      </header>

      <ol className="leaderboard-list">
        {sortedEntries.map((entry, index) => {
          const isCurrentUser = entry.userId === currentUserId;

          return (
            <li key={entry.userId} className={`leaderboard-row ${isCurrentUser ? "current" : ""}`}>
              <span className="rank">#{index + 1}</span>
              <span className="name">{entry.displayName}</span>
              <span className="tag" style={entry.allianceColor ? { color: entry.allianceColor } : undefined}>
                {formatAllianceTag(entry.allianceTag)}
              </span>
              <span className="score">{entry.score}</span>
            </li>
          );
        })}
      </ol>

      <div className="alliance-editor">
        <label htmlFor="alliance-tag-input">Alliance tag</label>
        <div className="alliance-input-row">
          <input
            id="alliance-tag-input"
            value={draftTag}
            onChange={(event) => {
              setDraftTag(event.target.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4));
            }}
            placeholder="ABC"
          />
          <button type="button" onClick={() => void saveAllianceTag()}>
            Save
          </button>
        </div>
        <div className="alliance-current">
          Active: <strong style={allianceColor ? { color: allianceColor } : undefined}>{formatAllianceTag(allianceTag)}</strong>
        </div>
      </div>
    </aside>
  );
}
