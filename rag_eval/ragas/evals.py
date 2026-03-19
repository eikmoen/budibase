import argparse
import csv
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple

from openai import OpenAI
from ragas.llms import llm_factory
from ragas.metrics import DiscreteMetric

VALIDATION_METRIC = DiscreteMetric(
    name="correctness",
    prompt=(
        "Evaluate if the response correctly answers the question according to the "
        "reference answer.\n"
        "Return only 'pass' or 'fail'.\n"
        "Question: {question}\n"
        "Reference: {reference}\n"
        "Response: {response}"
    ),
    allowed_values=["pass", "fail"],
)


def _normalize_row(row: Dict[str, str]) -> Dict[str, str]:
    question = (row.get("question") or row.get("user_input") or "").strip()
    response = (row.get("response") or row.get("answer") or "").strip()
    reference = (row.get("reference") or row.get("grading_notes") or "").strip()

    return {
        **row,
        "question": question,
        "response": response,
        "reference": reference,
    }


def evaluate_rows(rows: List[Dict[str, str]], model: str = "gpt-4o-mini") -> Tuple[List[Dict[str, str]], Dict[str, int]]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required to validate responses")

    openai_client = OpenAI(api_key=api_key)
    llm = llm_factory(model, client=openai_client)

    scored_rows: List[Dict[str, str]] = []
    passed = 0
    failed = 0
    skipped = 0

    for row in rows:
        normalized = _normalize_row(row)
        question = normalized["question"]
        response = normalized["response"]
        reference = normalized["reference"]

        if not question or not response or not reference:
            normalized["score"] = "skip"
            normalized["score_reason"] = (
                "Missing question, response, or reference."
            )
            scored_rows.append(normalized)
            skipped += 1
            continue

        score = VALIDATION_METRIC.score(
            llm=llm,
            question=question,
            reference=reference,
            response=response,
        )
        score_value = str(score.value).strip().lower()
        normalized["score"] = score_value
        normalized["score_reason"] = ""
        scored_rows.append(normalized)

        if score_value == "pass":
            passed += 1
        else:
            failed += 1

    return scored_rows, {
        "total": len(rows),
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
    }


def evaluate_csv(
    input_csv: Path,
    output_csv: Path,
    model: str = "gpt-4o-mini",
) -> Dict[str, int]:
    with input_csv.open("r", encoding="utf-8", newline="") as file:
        reader = csv.DictReader(file)
        rows = list(reader)

    scored_rows, summary = evaluate_rows(rows, model=model)

    output_csv.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = sorted({key for row in scored_rows for key in row.keys()})
    with output_csv.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(scored_rows)

    return summary


def main():
    parser = argparse.ArgumentParser(
        description="Validate RAG answers against references using Ragas."
    )
    parser.add_argument(
        "--input-csv",
        default="evals/datasets/testset.csv",
        help="CSV with question/user_input, reference, and response/answer columns.",
    )
    parser.add_argument(
        "--output-csv",
        default=f"evals/experiments/validated_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
        help="Where to write scored rows.",
    )
    parser.add_argument(
        "--model",
        default="gpt-4o-mini",
        help="Judge model used by ragas llm_factory.",
    )
    args = parser.parse_args()

    input_csv = Path(args.input_csv)
    output_csv = Path(args.output_csv)

    if not input_csv.exists():
        raise RuntimeError(f"Input CSV not found: {input_csv}")

    summary = evaluate_csv(input_csv=input_csv, output_csv=output_csv, model=args.model)
    print(f"Validation results saved to: {output_csv.resolve()}")
    print(
        f"Total={summary['total']} Passed={summary['passed']} Failed={summary['failed']} Skipped={summary['skipped']}"
    )

    if summary["failed"] > 0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
