export async function verifyWindowAction({ windows, instance, execute }, n, target, args, expected) {
  const check = () => {
    if (instance(n) !== expected) throw new Error('Desktop changed during window action; observe again');
  };
  check();
  await execute();
  const started = performance.now();
  while (performance.now() - started < 2000) {
    check();
    const current = (await windows(n)).find(w => w.address === target.address && w.pid === target.pid);
    check();
    const satisfied = args.action === 'close' ? !current : current && (
      args.action === 'focus' ? current.focused : args.action === 'fullscreen' ? current.fullscreen === args.enabled :
        current.x === args.x && current.y === args.y && current.w === args.width && current.h === args.height);
    if (satisfied) return { action: args.action, satisfied: true, ...(current ? { bounds: { x: current.x, y: current.y, width: current.w, height: current.h }, focused: current.focused, fullscreen: current.fullscreen } : { closed: true }) };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Window action was delivered but its result was not observed within 2000 ms');
}
