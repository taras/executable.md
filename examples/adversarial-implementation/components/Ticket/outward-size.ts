export function fitsOutward(value: unknown): boolean {
  const output = JSON.stringify(value, null, 2);
  const representations = JSON.stringify({ output, value: output, data: { work: value } });
  return (
    new TextEncoder().encode(representations).length +
      new TextEncoder().encode(output).length +
      4096 <=
    65_536
  );
}
