import { BaseCheckpointSaver } from "@langchain/langgraph";

type Tuple = NonNullable<Awaited<ReturnType<BaseCheckpointSaver["getTuple"]>>>;

function withoutSkillListing(tuple: Tuple): Tuple {
  const values = { ...tuple.checkpoint.channel_values };
  delete values.skillsMetadata;
  return { ...tuple, checkpoint: { ...tuple.checkpoint, channel_values: values },
    pendingWrites: tuple.pendingWrites?.filter(([, channel]) => channel !== "skillsMetadata") };
}

/** Runtime reads use the current skill catalog, including history/fork reads.
 * The underlying saver retains raw checkpoints for diagnostics. Messages,
 * files, interrupts and versions pass through unchanged. */
export class CurrentSkillsCheckpointer extends BaseCheckpointSaver {
  constructor(private readonly delegate: BaseCheckpointSaver) { super(delegate.serde); }

  async getTuple(...args: Parameters<BaseCheckpointSaver["getTuple"]>) {
    const tuple = await this.delegate.getTuple(...args);
    return tuple ? withoutSkillListing(tuple) : undefined;
  }

  async *list(...args: Parameters<BaseCheckpointSaver["list"]>) {
    for await (const tuple of this.delegate.list(...args)) yield withoutSkillListing(tuple);
  }

  put(...args: Parameters<BaseCheckpointSaver["put"]>) { return this.delegate.put(...args); }
  putWrites(...args: Parameters<BaseCheckpointSaver["putWrites"]>) { return this.delegate.putWrites(...args); }
  deleteThread(...args: Parameters<BaseCheckpointSaver["deleteThread"]>) { return this.delegate.deleteThread(...args); }
  getNextVersion(...args: Parameters<BaseCheckpointSaver["getNextVersion"]>) { return this.delegate.getNextVersion(...args); }
}
