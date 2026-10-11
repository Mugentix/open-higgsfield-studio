"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { syncAgentEvents } from "@/server/agent-actions";
import type { AgentEventPayload, AgentEventRecord, AgentRunRecord } from "@/server/agents-contract";
import { EVENTS_PAGE } from "@/server/agents-contract";

import { bounceIfSignedOut } from "./client";
import { announcementFor, pollInterval, receivePage } from "./events";

/* One run, kept live by plain polling: every tick asks for the events after
   the last seq of the pages this tab fetched, and the run record rides along
   so status and cost refresh with them. The questions and approvals come
   back as they stand too — a decision rewrites an event at a seq this tab
   has passed — and replace what is held by seq, without moving the
   watermark. Reconnect-safe by construction: a tab that slept asks from
   where it stopped; brisk only while the agent works. */
export function useAgentRun(runId: string, announce: (line: string | null) => void) {
  const [run, setRun] = useState<AgentRunRecord | null>(null);
  const [events, setEvents] = useState<AgentEventRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const runRef = useRef<AgentRunRecord | null>(null);
  const eventsRef = useRef<AgentEventRecord[]>([]);
  /** The highest seq a fetched page carried; gates past it are not counted. */
  const lastSeq = useRef(0);
  const live = useRef(true);
  const inflight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* How many looks the loop has taken since the run ended: one more, for
     events written after the status flipped, then it rests. */
  const tail = useRef(0);
  const scheduleRef = useRef<(ms: number) => void>(() => {});
  const announceRef = useRef(announce);
  announceRef.current = announce;

  /** One page from the server. Answers whether a full page came back, in
      which case the next one is asked for at once. */
  const sync = useCallback(async (): Promise<boolean> => {
    if (inflight.current) return false;
    inflight.current = true;
    try {
      const known = eventsRef.current;
      const result = await syncAgentEvents({ runId, afterSeq: lastSeq.current });
      if (!live.current) return false;
      if (!result.ok) {
        bounceIfSignedOut(result.code);
        setError(result.error);
        return false;
      }
      const held = new Set(known.map((event) => event.seq));
      const added = result.data.events.filter((event) => !held.has(event.seq));
      const received = receivePage(known, result.data, lastSeq.current);
      lastSeq.current = received.lastSeq;
      eventsRef.current = received.events;
      setEvents(received.events);
      const previous = runRef.current;
      runRef.current = result.data.run;
      setRun(result.data.run);
      setError(null);
      announceRef.current(announcementFor(previous, result.data.run, added));
      return result.data.events.length >= EVENTS_PAGE;
    } finally {
      inflight.current = false;
    }
  }, [runId]);

  useEffect(() => {
    live.current = true;
    tail.current = 0;
    runRef.current = null;
    eventsRef.current = [];
    lastSeq.current = 0;
    setRun(null);
    setEvents([]);
    setError(null);

    const schedule = (ms: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void tick(), ms);
    };
    scheduleRef.current = schedule;

    const tick = async () => {
      if (!live.current) return;
      /* A hidden tab asks nothing once it holds the run; it catches up the
         moment it is looked at again. */
      if (document.visibilityState !== "visible" && runRef.current) {
        schedule(2000);
        return;
      }
      let more = false;
      try {
        more = await sync();
      } catch {
        /* the next tick tries again */
      }
      if (!live.current) return;
      if (more) {
        schedule(0);
        return;
      }
      const status = runRef.current?.status;
      const interval = status ? pollInterval(status) : 3000;
      if (interval !== null) {
        schedule(interval);
        return;
      }
      if (tail.current < 1) {
        tail.current += 1;
        schedule(3000);
      }
    };

    void tick();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      tail.current = 0;
      schedule(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sync]);

  /** Ask now — after a message, an answer, a decision — rather than at the
      next tick, so the person's own words land in the stream at once. */
  const refresh = useCallback(() => {
    tail.current = 0;
    scheduleRef.current(0);
  }, []);

  /** A card settled from this tab shows so before the server confirms it. */
  const patchEvent = useCallback((seq: number, patch: (payload: AgentEventPayload) => AgentEventPayload) => {
    const next = eventsRef.current.map((event) => (event.seq === seq ? { ...event, payload: patch(event.payload) } : event));
    eventsRef.current = next;
    setEvents(next);
  }, []);

  const patchRun = useCallback((patch: Partial<AgentRunRecord>) => {
    if (!runRef.current) return;
    runRef.current = { ...runRef.current, ...patch };
    setRun(runRef.current);
  }, []);

  return { run, events, error, refresh, patchEvent, patchRun };
}
