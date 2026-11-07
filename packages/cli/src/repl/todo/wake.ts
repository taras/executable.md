export const TODO_WAKE =
  "Review the committed TODO changes supplied with this request and continue\nappropriately. Read Sidekick.Todo if you need the current checklist.";

interface TodoWakeReadiness {
  readonly live: boolean;
  readonly storage: boolean;
  readonly entry: boolean;
  readonly reservation: boolean;
  readonly dispatch: boolean;
  readonly configuration: boolean;
  readonly questions: boolean;
  readonly permissions: boolean;
  readonly conversation: boolean;
}

export function todoWakeEligible(readiness: TodoWakeReadiness): boolean {
  return (
    readiness.live &&
    readiness.storage &&
    readiness.entry &&
    readiness.reservation &&
    readiness.dispatch &&
    readiness.configuration &&
    readiness.questions &&
    readiness.permissions &&
    readiness.conversation
  );
}
