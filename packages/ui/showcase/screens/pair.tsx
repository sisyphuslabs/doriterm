import { Check, Server } from "lucide-react";
import { useState } from "react";
import { Button, EmptyState, Field, Fingerprint, Input, QrCode, SegmentedControl, cn } from "../../src/index.ts";
import { sampleQrModules } from "../data.ts";
import { BoardFrame } from "./frames.tsx";

const STEPS = ["Host", "Pair", "Verify"] as const;

function Steps({ current }: { readonly current: number }) {
  return (
    <ol aria-label="Pairing steps" className="flex items-center justify-center gap-2 text-sm">
      {STEPS.map((step, index) => (
        <li key={step} aria-current={index === current ? "step" : undefined} className="flex items-center gap-2">
          {index > 0 ? <span aria-hidden className="h-px w-6 bg-border" /> : null}
          <span
            className={cn(
              "flex items-center gap-1.5",
              index === current ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {index < current ? <Check aria-label="done" className="size-3.5" /> : <span data-numeric>{index + 1}</span>}
            {step}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function FirstRun() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-10 lg:justify-start lg:pt-16">
      <Steps current={0} />
      <EmptyState
        size="screen"
        icon={<Server />}
        title="Connect to a host"
        description="Doriterm shows the terminals and agents running on a computer with herdr-core. Start the host there, then pair this device."
        actions={
          <>
            <Button variant="primary" size="lg">
              Pair a host
            </Button>
            <Button variant="ghost" size="lg">
              How to start a host
            </Button>
          </>
        }
      >
        <code className="rounded-md bg-raised px-3 py-2 text-sm text-foreground">doriface-host pair</code>
      </EmptyState>
    </div>
  );
}

export function PairStep() {
  const [route, setRoute] = useState<"relay" | "direct">("relay");
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-5 px-6 py-10 lg:justify-start lg:pt-16">
      <Steps current={1} />
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-balance text-foreground">Pair this device</h1>
        <p className="mt-1.5 text-base text-pretty text-muted-foreground">
          Scan the code shown by the host, or type its pairing code.
        </p>
      </div>
      <QrCode modules={sampleQrModules()} label="Pairing QR code" className="mx-auto w-44 border border-border p-1" />
      <Field label="Pairing code" htmlFor="pair-code" hint="8 characters, letters and digits">
        <Input
          id="pair-code"
          mono
          defaultValue="F7K3 9D2M"
          autoComplete="one-time-code"
          className="h-(--control-lg) text-center text-lg"
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Connect through</span>
        <SegmentedControl
          label="Connect through"
          value={route}
          onValueChange={setRoute}
          options={[
            { value: "relay", label: "Relay" },
            { value: "direct", label: "Direct on LAN" },
          ]}
        />
        <p className="text-sm text-pretty text-muted-foreground">
          {route === "relay"
            ? "Works from anywhere. The relay only sees encrypted traffic."
            : "Only on the same network as the host. No relay involved."}
        </p>
      </div>
      <Button variant="primary" size="lg">
        Pair
      </Button>
    </div>
  );
}

export function VerifyStep() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-5 px-6 py-10 lg:justify-start lg:pt-16">
      <Steps current={2} />
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-balance text-foreground">Check the host's key</h1>
        <p className="mt-1.5 text-base text-pretty text-muted-foreground">
          The host prints the same groups when you run{" "}
          <code className="text-foreground">doriface-host fingerprint</code>.
        </p>
      </div>
      <div className="rounded-lg bg-raised p-4">
        <Fingerprint
          label="studio · host key fingerprint (SHA-256, truncated to 160 bits)"
          value="3fa94c0e7b21d8559e04a6c17f3bd2a08c4e6f19"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg">
          They match
        </Button>
        <Button variant="ghost" size="lg">
          They don't match
        </Button>
      </div>
    </div>
  );
}

export function PairScreen() {
  return (
    <main className="grid min-h-dvh gap-6 bg-background lg:grid-cols-3 lg:p-8">
      <BoardFrame label="1. First run, no host">
        <FirstRun />
      </BoardFrame>
      <BoardFrame label="2. Pair: scan or type the code">
        <PairStep />
      </BoardFrame>
      <BoardFrame label="3. Verify the host fingerprint">
        <VerifyStep />
      </BoardFrame>
    </main>
  );
}
