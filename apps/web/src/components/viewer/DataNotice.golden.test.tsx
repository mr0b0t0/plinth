// Golden text of the data notice for every combination of the gate's data fields, recorded
// before the notice became a list of line functions (DATA_NOTICE_LINES). The wording is the main
// anti-phishing signal on pages that collect input, so a refactor must not change one character.
import type { DataCapability, ViewGateData } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { dataNoticeText } from "./DataNotice.tsx";

const TOKENS: DataCapability[] = ["data", "viewer", "room"];

function* combinations(): Generator<[string, ViewGateData | undefined]> {
  yield ["no data block", undefined];
  for (let mask = 0; mask < 1 << TOKENS.length; mask++) {
    const capabilities = TOKENS.filter((_, i) => mask & (1 << i));
    for (const available of [true, false]) {
      for (const identified of [true, false]) {
        for (const email of [undefined, "ada@example.org"]) {
          for (const room_email of [undefined, "ada@example.org"]) {
            const data: ViewGateData = {
              available,
              capabilities,
              identified,
              can_write: identified,
              ...(email ? { email } : {}),
              ...(room_email ? { room_email } : {}),
            };
            const flags = `available=${available} identified=${identified} email=${!!email} room_email=${!!room_email}`;
            yield [`caps=[${capabilities.join(",")}] ${flags}`, data];
          }
        }
      }
    }
  }
}

describe("data notice golden", () => {
  it("says exactly what it said before, for every gate", async () => {
    const lines = [...combinations()].map(([name, data]) => `${name}\n  ${dataNoticeText(data)}`);
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("./__golden__/data-notice.txt");
  });
});
