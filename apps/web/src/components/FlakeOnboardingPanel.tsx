import type {
  FlakeOnboardingHostScale,
  FlakeOnboardingLayoutPattern,
  FlakeOnboardingModuleStyle,
  FlakeOnboardingPlatformMatrix,
} from "@t3tools/contracts";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";

const PATTERN_COPY: Record<FlakeOnboardingLayoutPattern, { title: string; description: string }> = {
  "single-host-minimal": {
    title: "Single host minimal",
    description: "Keep the repo lean and defer shared abstractions until the flake grows.",
  },
  "shared-modules": {
    title: "Shared modules",
    description: "Create a light shared structure that still stays simple for a small fleet.",
  },
  "fleet-layered": {
    title: "Fleet layered",
    description: "Prepare profiles and shared layers up front for a larger multi-host repo.",
  },
};

interface FlakeOnboardingPanelProps {
  projectName: string;
  projectCwd: string;
  nixDesignerEnabled: boolean;
  onNixDesignerEnabledChange: (enabled: boolean) => void;
  hostScale: FlakeOnboardingHostScale;
  onHostScaleChange: (value: FlakeOnboardingHostScale) => void;
  platformMatrix: FlakeOnboardingPlatformMatrix;
  onPlatformMatrixChange: (value: FlakeOnboardingPlatformMatrix) => void;
  homeManager: boolean;
  onHomeManagerChange: (value: boolean) => void;
  moduleStyle: FlakeOnboardingModuleStyle;
  onModuleStyleChange: (value: FlakeOnboardingModuleStyle) => void;
  moduleNamespace: string;
  onModuleNamespaceChange: (value: string) => void;
  moduleNamespaceError: string | null;
  layoutPattern: FlakeOnboardingLayoutPattern;
  skeletonPaths: ReadonlyArray<string>;
  pending: boolean;
  onSubmit: () => void;
}

export default function FlakeOnboardingPanel({
  projectName,
  projectCwd,
  nixDesignerEnabled,
  onNixDesignerEnabledChange,
  hostScale,
  onHostScaleChange,
  platformMatrix,
  onPlatformMatrixChange,
  homeManager,
  onHomeManagerChange,
  moduleStyle,
  onModuleStyleChange,
  moduleNamespace,
  onModuleNamespaceChange,
  moduleNamespaceError,
  layoutPattern,
  skeletonPaths,
  pending,
  onSubmit,
}: FlakeOnboardingPanelProps) {
  const patternCopy = PATTERN_COPY[layoutPattern];

  return (
    <section className="rounded-2xl border border-border/60 bg-card/60 p-5 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Create a new flake
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            HAL will bootstrap the smallest valid flake for{" "}
            <span className="font-medium text-foreground">{projectName}</span>, then open a
            plan-first workflow so the agent can refine the structure without inventing a layout.
          </p>
          <p className="mt-1 break-all text-xs text-muted-foreground/70">{projectCwd}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
          Creates <span className="font-medium text-foreground">`flake.nix`</span>,{" "}
          <span className="font-medium text-foreground">`.hal/repo-style.json`</span>, and scaffold
          directories only.
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">How many hosts?</span>
            <select
              value={hostScale}
              onChange={(event) =>
                onHostScaleChange(
                  event.target.value === "6+" ? "6+" : event.target.value === "2-5" ? "2-5" : "1",
                )
              }
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="1">1 host</option>
              <option value="2-5">2 to 5 hosts</option>
              <option value="6+">6+ hosts</option>
            </select>
            <span className="text-xs text-muted-foreground">
              This drives the default folder strategy and whether profiles are scaffolded now.
            </span>
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Platform matrix</span>
            <select
              value={platformMatrix}
              onChange={(event) =>
                onPlatformMatrixChange(
                  event.target.value === "mixed"
                    ? "mixed"
                    : event.target.value === "darwin"
                      ? "darwin"
                      : "nixos",
                )
              }
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="nixos">NixOS only</option>
              <option value="darwin">Darwin only</option>
              <option value="mixed">NixOS + Darwin</option>
            </select>
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Module style</span>
            <select
              value={moduleStyle}
              onChange={(event) =>
                onModuleStyleChange(
                  event.target.value === "explicit-modules" ? "explicit-modules" : "inline-first",
                )
              }
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="inline-first">Inline first</option>
              <option value="explicit-modules">Explicit modules</option>
            </select>
          </div>

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Module namespace</span>
            <Input
              value={moduleNamespace}
              placeholder="shared"
              onChange={(event) => onModuleNamespaceChange(event.target.value)}
            />
            <span
              className={cn(
                "text-xs",
                moduleNamespaceError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {moduleNamespaceError ??
                "Optional. When set, shared modules are placed under modules/<namespace>/..."}
            </span>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-border/60 bg-background/40 p-3">
            <Checkbox
              checked={homeManager}
              onCheckedChange={(checked) => onHomeManagerChange(checked === true)}
              aria-label="Use Home Manager"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Home Manager</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Create a `homes/` scaffold and bias the layout toward reusable shared modules.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 rounded-xl border border-border/60 bg-background/40 p-3">
            <Checkbox
              checked={nixDesignerEnabled}
              onCheckedChange={(checked) => onNixDesignerEnabledChange(checked === true)}
              aria-label="Enable Nix Designer MCP for the upcoming flake workflow"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Nix Designer MCP</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                If enabled, the upcoming workflow thread attaches the project-scoped Nix MCP once
                the dashboard is available.
              </span>
            </span>
          </label>

          <div className="flex items-center justify-end gap-3">
            <Button disabled={pending || moduleNamespaceError !== null} onClick={onSubmit}>
              {pending ? "Bootstrapping..." : "Create flake scaffold"}
            </Button>
          </div>
        </div>

        <aside className="rounded-2xl border border-border/60 bg-background/50 p-4">
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/8 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
              Suggested pattern
            </div>
            <div className="mt-2 text-base font-semibold text-foreground">{patternCopy.title}</div>
            <p className="mt-1 text-sm text-muted-foreground">{patternCopy.description}</p>
          </div>

          <div className="mt-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Directories HAL will create
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {skeletonPaths.map((path) => (
                <span
                  key={path}
                  className="rounded-md border border-border/60 bg-card px-2 py-1 font-mono text-[11px] text-foreground"
                >
                  {path}/
                </span>
              ))}
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-border/60 bg-card/70 p-3 text-xs text-muted-foreground">
            The bootstrap keeps `halHosts = {}` and `deploy.nodes = {}` present from day one, but it
            does not add hosts, deploy wiring, or a `flake.lock` yet.
          </div>
        </aside>
      </div>
    </section>
  );
}
