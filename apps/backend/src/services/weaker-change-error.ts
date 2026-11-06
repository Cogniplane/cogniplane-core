/**
 * A store refused a change because it makes a control weaker and the caller
 * did not allow that (the caller has no step-up yet). The store throws it in
 * the change's transaction, after it classified the change against the locked
 * data, so the transaction rolls back and nothing changes.
 * DataRouteControl.writeWithStepUpIfWeaker then asks for step-up and writes
 * again.
 */
export class WeakerChangeError extends Error {
  constructor() {
    super("The change makes a control weaker and needs step-up.");
    this.name = "WeakerChangeError";
  }
}
