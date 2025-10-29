// ABOUTME: Processes forwarder registry events to persist interval history and snapshots
// ABOUTME: Registers Envio HyperIndex handlers for setReg and expReg events
import {
  ForwarderRegistry,
  type ForwarderRegistry_SetReg_event,
  type ForwarderRegistry_ExpReg_event,
  type handlerContext,
} from "./generated";

const OPEN_ENDED = 0xfffffffffn; // 68719476735

const intervalKey = (from: string, start: bigint): string =>
  `${from.toLowerCase()}-${start.toString()}`;

const registrationKey = (from: string): string => from.toLowerCase();

type MutableInterval = {
  id: string;
  from: string;
  to: string;
  start: bigint;
  expiration: bigint;
  canceled: boolean;
  txHash: string;
  blockNumber: bigint;
  timestamp: bigint;
};

type MutableRegistration = {
  id: string;
  from: string;
  to: string;
  start: bigint;
  expiration: bigint;
  lastUpdatedAt: bigint;
};

const buildInterval = (
  base: Partial<MutableInterval> & Pick<MutableInterval, "id">
): MutableInterval => ({
  from: base.from ?? "",
  to: base.to ?? "",
  start: base.start ?? 0n,
  expiration: base.expiration ?? OPEN_ENDED,
  canceled: base.canceled ?? false,
  txHash: base.txHash ?? "",
  blockNumber: base.blockNumber ?? 0n,
  timestamp: base.timestamp ?? 0n,
  ...base,
});

const buildRegistration = (
  base: Partial<MutableRegistration> & Pick<MutableRegistration, "id">
): MutableRegistration => ({
  from: base.from ?? "",
  to: base.to ?? "",
  start: base.start ?? 0n,
  expiration: base.expiration ?? OPEN_ENDED,
  lastUpdatedAt: base.lastUpdatedAt ?? 0n,
  ...base,
});

const setInterval = async (
  context: handlerContext,
  intervalId: string,
  update: (previous?: MutableInterval) => MutableInterval
) => {
  const existing = await context.Interval.get(intervalId);
  const next = update(existing as MutableInterval | undefined);
  context.Interval.set(next);
};

const setRegistration = async (
  context: handlerContext,
  registrationId: string,
  update: (previous?: MutableRegistration) => MutableRegistration
) => {
  const existing = await context.Registration.get(registrationId);
  const next = update(existing as MutableRegistration | undefined);
  context.Registration.set(next);
};

ForwarderRegistry.SetReg.handler(
  async ({
    event,
    context,
  }: {
    event: ForwarderRegistry_SetReg_event;
    context: handlerContext;
  }) => {
    await handleSetReg(event, context);
  }
);

ForwarderRegistry.ExpReg.handler(
  async ({
    event,
    context,
  }: {
    event: ForwarderRegistry_ExpReg_event;
    context: handlerContext;
  }) => {
    await handleExpReg(event, context);
  }
);

export async function handleSetReg(
  event: ForwarderRegistry_SetReg_event,
  context: handlerContext
): Promise<void> {
  const from = event.params._from.toLowerCase();
  const to = event.params._to.toLowerCase();
  const start = event.params._start;
  const intervalId = intervalKey(from, start);
  const blockNumber = BigInt(event.block.number);
  const timestamp = BigInt(event.block.timestamp);
  const txHash = event.transaction.hash ?? "";

  await setInterval(context, intervalId, (previous) =>
    buildInterval({
      id: intervalId,
      from,
      to,
      start,
      expiration: OPEN_ENDED,
      canceled: false,
      txHash,
      blockNumber,
      timestamp,
      ...previous,
    })
  );

  const registrationId = registrationKey(from);
  await setRegistration(context, registrationId, (previous) =>
    buildRegistration({
      id: registrationId,
      from,
      to,
      start,
      expiration: OPEN_ENDED,
      lastUpdatedAt: timestamp,
      ...previous,
    })
  );
}

export async function handleExpReg(
  event: ForwarderRegistry_ExpReg_event,
  context: handlerContext
): Promise<void> {
  const from = event.params._from.toLowerCase();
  const end = event.params._end;
  const timestamp = BigInt(event.block.timestamp);
  const blockNumber = BigInt(event.block.number);
  const txHash = event.transaction.hash ?? "";
  const cancelId = intervalKey(from, end);

  const pending = await context.Interval.get(cancelId);
  if (pending) {
    await setInterval(context, cancelId, () =>
      buildInterval({
        ...(pending as MutableInterval),
        expiration: end,
        canceled: true,
        txHash,
        blockNumber,
        timestamp,
      })
    );

    const snapshot = await context.Registration.get(registrationKey(from));
    if (
      snapshot &&
      snapshot.start === end &&
      snapshot.expiration === OPEN_ENDED
    ) {
      await setRegistration(context, registrationKey(from), () =>
        buildRegistration({
          ...(snapshot as MutableRegistration),
          expiration: end,
          lastUpdatedAt: timestamp,
        })
      );
    }
    return;
  }

  const snapshot = await context.Registration.get(registrationKey(from));
  if (!snapshot) {
    return;
  }

  const openId = intervalKey(from, snapshot.start);
  const openInterval = await context.Interval.get(openId);
  if (openInterval && openInterval.expiration === OPEN_ENDED) {
    await setInterval(context, openId, () =>
      buildInterval({
        ...(openInterval as MutableInterval),
        expiration: end,
        txHash,
        blockNumber,
        timestamp,
      })
    );
  }

  await setRegistration(context, registrationKey(from), () =>
    buildRegistration({
      ...(snapshot as MutableRegistration),
      expiration: end,
      lastUpdatedAt: timestamp,
    })
  );
}

export const __testUtils = {
  intervalKey,
  registrationKey,
  OPEN_ENDED,
};
