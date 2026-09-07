import assert from "node:assert/strict";
import { test } from "node:test";
import { isFinalJobFailure } from "./failure.js";

test("DLQ eligibility starts only after BullMQ exhausts attempts", () => {
  assert.equal(isFinalJobFailure(undefined), true);
  assert.equal(isFinalJobFailure({ attemptsMade: 1, opts: { attempts: 3 } } as never), false);
  assert.equal(isFinalJobFailure({ attemptsMade: 2, opts: { attempts: 3 } } as never), false);
  assert.equal(isFinalJobFailure({ attemptsMade: 3, opts: { attempts: 3 } } as never), true);
  assert.equal(isFinalJobFailure({ attemptsMade: 1, opts: {} } as never), true);
});
