/** Runs a connect's stages on its relay link and closes the link whatever they did, failed stages included (#1289). */
export async function onLink<Link extends { close(): void }, T>(
  link: Link,
  stages: (link: Link) => Promise<T>,
): Promise<T> {
  try {
    return await stages(link);
  } finally {
    link.close();
  }
}
