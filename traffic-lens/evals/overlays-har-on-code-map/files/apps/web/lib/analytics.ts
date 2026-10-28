export async function track(event: string, props: Record<string, unknown>) {
  await fetch('https://api.mixpanel.com/track', {
    method: 'POST',
    body: JSON.stringify([{ event, properties: props }]),
  });
}
