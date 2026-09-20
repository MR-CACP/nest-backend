import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

/** 参数校验演示 DTO */
export class EchoDto {
  @IsString()
  @IsNotEmpty({ message: 'name 不能为空' })
  name: string;

  @IsInt({ message: 'age 必须是整数' })
  @Min(0, { message: 'age 最小为 0' })
  @Max(150, { message: 'age 最大为 150' })
  age: number;
}
