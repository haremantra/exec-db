import { SignUp } from "@clerk/nextjs";

export default function SignUpPage(): JSX.Element {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <SignUp />
    </div>
  );
}
