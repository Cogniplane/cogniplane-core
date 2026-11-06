// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import ArtifactCodeBlock from "./artifact-code-block";

afterEach(cleanup);

it.each(["typescript", "plaintext", "unknown-language"])("preserves exact %s source and gives its scroll region a keyboard path", language => {
  const code = '  const text = "<value> & source";\n\n    indented();\n';
  render(<ArtifactCodeBlock language={language} code={code} />);
  const region = screen.getByRole("region", { name: "Code preview" });
  expect(region.textContent).toBe(code);
  expect(region.tabIndex).toBe(0);
  expect(region.querySelector("value")).toBeNull();
  expect(region.querySelector("code")).toBeTruthy();
});
