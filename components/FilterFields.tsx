// GET-form filter fields for the inventory pages (AGENTS.md §6): floating-
// label structure with the load-bearing single-space placeholder; selects use
// the vendored SELECT structure with an empty "Any" option meaning
// "not filtered" (the boundary treats empty string as absent).
export interface SelectFilterProps {
  name: string;
  label: string;
  options: readonly string[];
  selected: string | null;
  size?: string;
}

export function SelectFilter(
  { name, label, options, selected, size = "s12 m6 l3" }: SelectFilterProps,
) {
  return (
    <div class={`field label border small ${size}`}>
      <select name={name}>
        <option value="">Any</option>
        {options.map((option) => (
          <option value={option} selected={option === selected}>
            {option.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      <label>{label}</label>
    </div>
  );
}

export interface TextFilterProps {
  name: string;
  label: string;
  value: string | null;
  type?: string;
  size?: string;
}

export function TextFilter(
  { name, label, value, type = "text", size = "s12 m6 l3" }: TextFilterProps,
) {
  return (
    <div class={`field label border small ${size}`}>
      <input type={type} name={name} placeholder=" " value={value ?? ""} />
      <label>{label}</label>
    </div>
  );
}
