// Label query endpoint split out.
export function registerLabeler(router: any, log: any, json: any,
  ComAtprotoLabelQueryLabels: any, queryLabels: any, labelToJson: any,
) {
  router.addQuery(ComAtprotoLabelQueryLabels.mainSchema, {
    async handler({ params }: any) {
      const result = await queryLabels({
        uriPatterns: params.uriPatterns,
        sources: params.sources,
        cursor: params.cursor ? Number(params.cursor) : undefined,
        limit: params.limit,
      });
      return json({
        labels: result.labels.map(labelToJson),
        cursor: result.cursor !== undefined ? String(result.cursor) : undefined,
      } as unknown as typeof ComAtprotoLabelQueryLabels.$output);
    },
  });
}
