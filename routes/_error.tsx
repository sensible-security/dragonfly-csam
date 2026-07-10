import { HttpError } from "fresh";
import { define } from "../utils.ts";

export default define.page(function ErrorPage(ctx) {
  const status = ctx.error instanceof HttpError ? ctx.error.status : 500;

  return (
    <article class="border round">
      <h5>
        {status === 404
          ? "404 — Page not found"
          : `${status} — Something went wrong`}
      </h5>
      <p>
        {status === 404
          ? "The page you were looking for doesn't exist."
          : "An unexpected error occurred."}
      </p>
      <nav>
        <a class="button" href="/">Go to Dashboard</a>
      </nav>
    </article>
  );
});
