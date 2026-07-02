import { isBusinessHours, vancouverToday } from "./dates";
import { sendAndLog } from "./email";
import { reportDueReminder } from "./emailTemplates";
import { listRequests, readBrokerage, readRequest, writeRequest } from "./storage";

// Report-due reminders. Single Railway instance ⇒ an in-process hourly tick is
// sufficient; state (reminder_last_sent_date) is persisted on the request so
// restarts and overlapping ticks can't double-send. Re-nags DAILY while the
// report is overdue and unsent — an unsent report is the one thing that must
// not silently rot. The board's due badges are the second, stateless surfacing
// of the same condition.

const TICK_MS = 60 * 60 * 1000;

export function startReminderLoop(): void {
  const globals = globalThis as { __adreport_reminder_loop?: boolean };
  if (globals.__adreport_reminder_loop) return; // dev hot-reload / double-import guard
  globals.__adreport_reminder_loop = true;
  // Node timers — unref so an idle interval never holds the process open.
  const interval: any = setInterval(() => void tick(), TICK_MS);
  interval.unref?.();
  // First pass shortly after boot (not immediately — let the server come up).
  const kickoff: any = setTimeout(() => void tick(), 15_000);
  kickoff.unref?.();
  console.log("[reminders] report-due reminder loop started (hourly, Mon-Fri 9-5 America/Vancouver)");
}

export async function tick(): Promise<void> {
  try {
    // Reminders land during the spec's send window only.
    if (!isBusinessHours()) return;
    const today = vancouverToday();

    const requests = await listRequests();
    for (const request of requests) {
      if (request.status !== "campaign_in_progress") continue;
      if (!request.report_due_date || request.report_due_date > today) continue;
      if (request.reminder_last_sent_date === today) continue;

      try {
        const brokerage = await readBrokerage(request.brokerage_slug);
        await sendAndLog(request.id, "report_due_reminder", reportDueReminder(request, brokerage));
        // Re-read and write only the field this loop owns — an admin form save
        // between our read and write must not be clobbered.
        const fresh = await readRequest(request.id);
        fresh.reminder_last_sent_date = today;
        await writeRequest(fresh);
      } catch (error) {
        console.warn(`[reminders] reminder failed for ${request.id}:`, error);
      }
    }
  } catch (error) {
    console.warn("[reminders] tick failed:", error);
  }
}
