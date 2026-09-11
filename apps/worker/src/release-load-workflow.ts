import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  type LoadOutcome,
  loadRelease,
  type ReleaseLoadParams,
  type Steps,
} from "./release-load.ts";

/** The Workflow around the loader: one part a step, each step retried and bounded (#83). */
export class ReleaseLoad extends WorkflowEntrypoint<Env, ReleaseLoadParams> {
  async run(event: WorkflowEvent<ReleaseLoadParams>, step: WorkflowStep): Promise<LoadOutcome> {
    const steps: Steps = {
      // A step's result has to be serialisable, which every result here is; the loader's own
      // signature does not say so, hence the cast.
      do: <T>(name: string, fn: () => Promise<T>) =>
        step.do(
          name,
          {
            retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
            timeout: "5 minutes",
          },
          fn as unknown as () => Promise<never>,
        ) as unknown as Promise<T>,
    };
    return loadRelease(this.env.ARCHIVE, this.env.RELEASES, steps, event.payload.release);
  }
}
