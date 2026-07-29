import { conflict } from "./errors";

let activeMutableOperations = 0;
let activeDataOperation: string | null = null;

export function reserveMutableOperation(label: string) {
  if (activeDataOperation) {
    throw conflict(
      `Wait for ${activeDataOperation} to finish before ${label}.`,
      "data_operation_active",
    );
  }
  activeMutableOperations += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeMutableOperations = Math.max(0, activeMutableOperations - 1);
  };
}

export async function withMutableOperation<T>(
  label: string,
  operation: () => Promise<T>,
) {
  const release = reserveMutableOperation(label);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function withExclusiveDataOperation<T>(
  label: string,
  operation: () => T,
) {
  if (activeDataOperation) {
    throw conflict(
      `Wait for ${activeDataOperation} to finish before ${label}.`,
      "data_operation_active",
    );
  }
  if (activeMutableOperations > 0) {
    throw conflict(
      `Wait for ${activeMutableOperations} active network operation${
        activeMutableOperations === 1 ? "" : "s"
      } to finish before ${label}.`,
      "active_network_operation",
    );
  }
  activeDataOperation = label;
  try {
    return operation();
  } finally {
    activeDataOperation = null;
  }
}
