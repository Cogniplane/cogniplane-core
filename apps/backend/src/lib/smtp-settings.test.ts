import { expect, test } from "vitest";

import { parseMailFrom, parseSmtpUrl } from "./smtp-settings.js";

test("smtps:// is TLS from the start; smtp:// must upgrade with STARTTLS", () => {
  expect(parseSmtpUrl("smtps://user:pass@smtp.example.test", false)).toEqual({
    host: "smtp.example.test", port: 465, secure: true, requireTLS: false, auth: { user: "user", pass: "pass" }
  });
  expect(parseSmtpUrl("smtp://user:pass@smtp.example.test", false)).toEqual({
    host: "smtp.example.test", port: 587, secure: false, requireTLS: true, auth: { user: "user", pass: "pass" }
  });
  expect(parseSmtpUrl("smtp://smtp.example.test:2525", false)).toEqual({ host: "smtp.example.test", port: 2525, secure: false, requireTLS: true });
  // The development opt-in lets smtp:// go without TLS; it never weakens smtps://.
  expect(parseSmtpUrl("smtp://localhost:1025", true)).toMatchObject({ requireTLS: false, secure: false });
  expect(parseSmtpUrl("smtps://localhost", true)).toMatchObject({ secure: true });
});

test("credentials are URL-decoded; IPv6 hosts lose their brackets", () => {
  expect(parseSmtpUrl("smtps://apikey:p%40ss%3Aword@[::1]:465", false)).toMatchObject({
    host: "::1", auth: { user: "apikey", pass: "p@ss:word" }
  });
});

test("bad URLs are refused without repeating them", () => {
  for (const raw of ["not a url", "http://smtp.example.test", "smtp://u:secret@h/path", "smtp://u:secret@h?tls=off", "smtps://user@h", "smtp://:secret@h"]) {
    let message = "";
    try {
      parseSmtpUrl(raw, false);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, raw).not.toBe("");
    expect(message).not.toContain("secret");
  }
});

test("MAIL_FROM: an address, or a name and an address, on one line", () => {
  expect(parseMailFrom("no-reply@example.test")).toEqual({ name: null, address: "no-reply@example.test" });
  expect(parseMailFrom("Cogniplane <No-Reply@Example.test>")).toEqual({ name: "Cogniplane", address: "no-reply@example.test" });
  expect(parseMailFrom('"Acme IT" <it@example.test>')).toEqual({ name: "Acme IT", address: "it@example.test" });
  expect(() => parseMailFrom("Cogniplane")).toThrow(/MAIL_FROM must be an email address/);
  expect(() => parseMailFrom("a@example.test\r\nBcc: x@example.test")).toThrow(/one line/);
  expect(() => parseMailFrom('Bad "Name" <a@example.test>')).toThrow(/quotes/);
});
