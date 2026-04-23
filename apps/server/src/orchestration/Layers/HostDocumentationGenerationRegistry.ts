import { Effect, Layer, Ref } from "effect";

import {
  HostDocumentationGenerationRegistry,
  type HostDocumentationGenerationJob,
  type HostDocumentationGenerationRegistryShape,
} from "../Services/HostDocumentationGenerationRegistry.ts";

function jobKey(input: { workspaceRoot: string; hostName: string }): string {
  return `${input.workspaceRoot}\u0000${input.hostName.trim().toLowerCase()}`;
}

const make = Effect.gen(function* () {
  const jobsRef = yield* Ref.make(new Map<string, HostDocumentationGenerationJob>());

  const getJob: HostDocumentationGenerationRegistryShape["getJob"] = (input) =>
    Ref.get(jobsRef).pipe(Effect.map((jobs) => jobs.get(jobKey(input)) ?? null));

  const ensureJob: HostDocumentationGenerationRegistryShape["ensureJob"] = (input) =>
    Ref.modify<
      Map<string, HostDocumentationGenerationJob>,
      {
        readonly created: boolean;
        readonly job: HostDocumentationGenerationJob;
      }
    >(jobsRef, (jobs) => {
      const key = jobKey(input);
      const existing = jobs.get(key);
      if (existing) {
        return [
          {
            created: false,
            job: existing,
          },
          jobs,
        ] as const;
      }

      const next = new Map(jobs);
      const job: HostDocumentationGenerationJob = {
        hostName: input.hostName.trim(),
        queuedAt: new Date().toISOString(),
        workspaceRoot: input.workspaceRoot,
      };
      next.set(key, job);
      return [
        {
          created: true,
          job,
        },
        next,
      ] as const;
    });

  const removeJob: HostDocumentationGenerationRegistryShape["removeJob"] = (input) =>
    Ref.update(jobsRef, (jobs) => {
      const next = new Map(jobs);
      next.delete(jobKey(input));
      return next;
    });

  return {
    getJob,
    ensureJob,
    removeJob,
  } satisfies HostDocumentationGenerationRegistryShape;
});

export const HostDocumentationGenerationRegistryLive = Layer.effect(
  HostDocumentationGenerationRegistry,
  make,
);
