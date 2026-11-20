# Native review extensions

The shipped desktop integration is described in [Review workflow](../arch/01-platform/03-review-workflow.md) and [GUI interaction](../arch/03-gui/01-ui-interaction.md). This draft retains the alternatives and validation questions for future work. See [review engine comparison](../reference/review-engine-comparison.md) for the research baseline.

## Transport and context experiments

- Evaluate App Server `review/start` if the desktop needs a persistent thread or an explicit interruption lifecycle. Compare initialization, event framing, cancellation, and process cleanup against the current CLI transport.
- Evaluate session resumption and context compression using long question sequences and PRs whose target or head changes. Measure whether compacted context preserves prior findings and supporting locations. Include the disk use and cleanup implications of any persistent runtime state.
- Test Windows and macOS with GUI-launched PATH, supported installation methods, and installed-app permissions. Verify reported model and usage fields before using them in cost comparisons.

## Review workflow experiments

- Measure defect recall, precision, evidence quality, latency, and cost before adding native background runs or another model pass around the native reviewer.
- Investigate a cross-engine comparison view once results are measured on matching snapshots. Require each finding and draft to retain its source run and engine when similar results are grouped.
- Explore additional native reviewer capabilities and transport versions using local fixtures. Review test execution and repository instruction loading against the app's existing trust boundary before expanding runtime permissions.
