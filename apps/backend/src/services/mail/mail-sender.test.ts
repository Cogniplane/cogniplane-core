import nodemailer from "nodemailer";
import { expect, test } from "vitest";

import { retryDelayMs } from "./mail-outbox-worker.js";
import { classifySendError, InvalidRecipientError, SmtpMailSender } from "./mail-sender.js";

test("a 5xx refusal of the recipient or the message is final; other failures retry", () => {
  expect(classifySendError(Object.assign(new Error("550 no such user"), { code: "EENVELOPE", responseCode: 550 })))
    .toEqual({ code: "EENVELOPE 550", permanent: true });
  expect(classifySendError(Object.assign(new Error("552 too big"), { code: "EMESSAGE", responseCode: 552 })))
    .toEqual({ code: "EMESSAGE 552", permanent: true });
  // The operator fixes these: wrong password, server down, greylisting.
  expect(classifySendError(Object.assign(new Error("535 auth"), { code: "EAUTH", responseCode: 535 })))
    .toEqual({ code: "EAUTH 535", permanent: false });
  expect(classifySendError(Object.assign(new Error("451 try later"), { code: "EENVELOPE", responseCode: 451 })))
    .toEqual({ code: "EENVELOPE 451", permanent: false });
  expect(classifySendError(Object.assign(new Error("refused"), { code: "ECONNECTION" }))).toEqual({ code: "ECONNECTION", permanent: false });
});

test("the stored code never carries server text", () => {
  expect(classifySendError(new Error("550 <max@example.test> unknown")).code).toBe("ERROR");
  expect(classifySendError({ code: "550 <max@example.test>", responseCode: "550" }).code).toBe("ERROR");
  expect(classifySendError(null).code).toBe("ERROR");
});

test("retries wait 1, 2, 4 ... minutes, at most one hour", () => {
  expect([1, 2, 3, 4, 6, 7, 8, 20].map((attempt) => retryDelayMs(attempt) / 60_000)).toEqual([1, 2, 4, 8, 32, 60, 60, 60]);
});

test("the SMTP envelope and the To header hold exactly the account's address", async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const sent: { envelope: unknown; message: string }[] = [];
  const recorder = {
    sendMail: async (options: Parameters<typeof transport.sendMail>[0]) => {
      const info = await transport.sendMail(options);
      sent.push({ envelope: info.envelope, message: info.message as string });
      return info;
    },
    close: () => transport.close()
  };
  const sender = new SmtpMailSender(
    { host: "unused", port: 465, secure: true, requireTLS: false },
    { name: "Cogniplane", address: "no-reply@example.test" },
    recorder as never
  );
  await sender.send({ to: "max@example.test", subject: "s", text: "t", html: "<p>t</p>" });
  expect(sent[0]!.envelope).toEqual({ from: "no-reply@example.test", to: ["max@example.test"] });
  expect(JSON.parse(sent[0]!.message).to).toEqual([{ address: "max@example.test", name: "" }]);

  // Address-list text never reaches the transport.
  for (const to of ["alice<attacker@example.test>", "a@example.test, b@example.test", "Max@Example.test"]) {
    const error = await sender.send({ to, subject: "s", text: "t", html: "t" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidRecipientError);
    expect(classifySendError(error)).toEqual({ code: "BAD_ADDRESS", permanent: true });
  }
  expect(sent).toHaveLength(1);
});
