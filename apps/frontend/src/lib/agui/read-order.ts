// One counter for this tab. It orders the reads of saved session data and the
// live events of the chat connection. A read takes its number when the request
// starts. So a saved result that a live event already replaced is recognized
// when it arrives late, without a comparison of clocks.
let order = 0;

export function nextReadOrder(): number {
  order += 1;
  return order;
}
