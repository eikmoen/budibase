from langchain_community.document_loaders import DirectoryLoader, TextLoader


print(f"Loading source docs")
path = "datasets"
loader = DirectoryLoader(
    path,
    glob="*.md",
)
docs = loader.load()
print(f"Loaded {len(docs)} source docs")

from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import OpenAIEmbeddings
from langchain_openai import ChatOpenAI
import openai

generator_llm = LangchainLLMWrapper(ChatOpenAI(model="gpt-4o"))
openai_client = openai.OpenAI()
generator_embeddings = OpenAIEmbeddings(client=openai_client)

from ragas.testset import TestsetGenerator

generator = TestsetGenerator(llm=generator_llm, embedding_model=generator_embeddings)
dataset = generator.generate_with_langchain_docs(docs, testset_size=10)
print(f"Generated {len(dataset.samples)} testset samples")


df = dataset.to_pandas()

from pathlib import Path

out_dir = Path("evals/datasets")
out_dir.mkdir(parents=True, exist_ok=True)
out_file = out_dir / f"testset.csv"
df.to_csv(out_file, index=False)
print(f"Saved testset to: {out_file}")

if df.empty:
  print("No rows generated. Add more source docs in datasets/ or lower testset_size.")
