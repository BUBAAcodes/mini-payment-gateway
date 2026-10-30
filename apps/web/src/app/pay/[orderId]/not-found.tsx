/** A wrong order ID or client secret. Both look the same, so neither can be probed. */
export default function PaymentLinkNotFound() {
  return (
    <section className="max-w-xl">
      <p className="text-sm font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Payment link
      </p>
      <h1 className="font-display mt-4 animate-blur-in text-4xl uppercase md:text-5xl">
        This link is not valid
      </h1>
      <p className="mt-6 text-base text-muted-foreground">
        It may be mistyped or out of date. Go back to the shop and start the payment again.
      </p>
    </section>
  );
}
