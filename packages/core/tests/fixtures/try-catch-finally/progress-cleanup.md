<File path="review-in-progress.txt">Review is active.</File>
<Try>
  <Elicit schema={{ type: "string" }} as="continuation">Choose how the review should continue.</Elicit>
  <Catch>Recovery entered.</Catch>
  <Finally>
    <File.Delete path="review-in-progress.txt" />
  </Finally>
</Try>
